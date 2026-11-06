import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Express } from "express";
import { encodeFunctionData, keccak256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayActionDomain, gatewayActionMessage, GATEWAY_ACTION_TYPES } from "./chain/gatewayAction.js";
import { parseInitialChainJobSnapshot } from "./chain/chainJobImport.js";
import { OFFER_TYPES } from "./chain/signing.js";
import type { JobAuthorityReader, SepoliaAuthorityReader } from "./chain/sepoliaAuthority.js";
import type { EscrowMutationWriter } from "./chain/sepoliaEscrowWriter.js";
import { JobStore } from "./domain/jobs/jobStore.js";
import { digest, serialise, type Hex, type JobSnapshot } from "./protocol/v1.js";
import { Gateway, LocalPaymentProvider, type PaymentResult } from "./services/gateway/gateway.js";
import { OperationLedger } from "./services/ledger/operationLedger.js";

const buyer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
const worker = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const workerB = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000003");
const escrow = "0x5555555555555555555555555555555555555555" as Hex;
const adapter = "0x6666666666666666666666666666666666666666" as Hex;
let authNonceCounter = 0;

process.env.NODE_ENV = "production";
process.env.GATEWAY_AUTHORITY_MODE = "sepolia";
process.env.SEPOLIA_CHAIN_ID = "11155111";
process.env.SEPOLIA_RPC_URL = "https://rpc.example.invalid";
process.env.BATON_ESCROW_ADDRESS = escrow;
process.env.BATON_AUTHORITY_ADAPTER_ADDRESS = adapter;

const [{ createApp }, { env }] = await Promise.all([
  import("./app.js"),
  import("./config/env.js"),
]);

test("status does not report Arkiv active without the server signer", async () => {
  const fixture = await createFixture();
  const previousSigner = env.ARKIV_SIGNER_PRIVATE_KEY;
  try {
    env.ARKIV_SIGNER_PRIVATE_KEY = "";
    const status = await dispatch(fixture.app, "GET", "/api/status", {});
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.contentStore, "unconfigured");
    assert.equal(status.body.configuration.arkiv, false);
  } finally {
    env.ARKIV_SIGNER_PRIVATE_KEY = previousSigner;
    fixture.ledger.close();
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test("production API permits chain import and signed buyer assignment but blocks fixture routes", async () => {
  const fixture = await createFixture();
  try {
    const snapshot = makeSnapshot(fixture.jobs);
    assert.deepEqual(parseInitialChainJobSnapshot(serialise(snapshot)), snapshot);

    const fixtureCreate = await dispatch(fixture.app, "POST", "/api/jobs", {});
    assert.equal(fixtureCreate.statusCode, 503);
    assert.equal(fixtureCreate.body.error, "LOCAL_FIXTURE_DISABLED");

    const unsignedImport = await dispatch(fixture.app, "POST", "/api/jobs/import", { snapshot: serialise(snapshot) });
    assert.equal(unsignedImport.statusCode, 409);
    assert.equal(unsignedImport.body.error, "INVALID_AUTH_NONCE");
    assert.equal(fixture.importReads(), 0);
    assert.equal((await fixture.jobs.list()).length, 0);

    const signedImport = await signedImportBody(snapshot, "0x" + "a".repeat(64) as Hex);
    const created = await dispatch(fixture.app, "POST", "/api/jobs/import", signedImport);
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.terms.jobId, snapshot.terms.jobId);
    assert.equal(fixture.importReads(), 1);
    assert.equal((await fixture.ledger.getBalance(snapshot.terms.jobId))?.available, snapshot.terms.serviceBudget);

    const idempotentImport = await dispatch(
      fixture.app,
      "POST",
      "/api/jobs/import",
      await signedImportBody(snapshot, "0x" + "b".repeat(64) as Hex),
    );
    assert.equal(idempotentImport.statusCode, 200);
    assert.equal(fixture.importReads(), 1);

    const assignmentJob = (await fixture.jobs.get(snapshot.terms.jobId))!;
    const assignment = await signedActionBody({
      job: assignmentJob,
      signer: buyer,
      action: "ASSIGN_WORKER",
      epoch: assignmentJob.task.epoch,
      payload: { worker: worker.address.toLowerCase() },
      body: { worker: worker.address },
    });
    const assigned = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/assign`, assignment);
    assert.equal(assigned.statusCode, 200, JSON.stringify(assigned.body));

    const unsignedOperations = await dispatch(
      fixture.app,
      "GET",
      `/api/jobs/${snapshot.terms.jobId}/services/operations`,
      {},
    );
    assert.equal(unsignedOperations.statusCode, 503);
    assert.equal(unsignedOperations.body.error, "LOCAL_FIXTURE_DISABLED");

    const unsignedExecute = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/services/execute`, {
      operationId: "unsigned-production-payment",
      taskId: snapshot.task.taskId,
      worker: worker.address,
      epoch: 1,
      service: "batch-data-v1",
      inputDigest: digest("unsigned production input"),
      amount: "1",
      asset: "HBAR",
    });
    assert.equal(unsignedExecute.statusCode, 409);
    assert.equal(unsignedExecute.body.error, "INVALID_AUTH_NONCE");
    assert.equal(fixture.providerSubmissions(), 0);

    for (const route of [
      `/api/jobs/${snapshot.terms.jobId}/drain`,
      `/api/jobs/${snapshot.terms.jobId}/takeover`,
      `/api/jobs/${snapshot.terms.jobId}/cancel-drain`,
    ]) {
      const blocked = await dispatch(fixture.app, "POST", route, {});
      assert.equal(blocked.statusCode, 503, `production must block ${route}`);
      assert.equal(blocked.body.error, "LOCAL_FIXTURE_DISABLED");
    }
  } finally {
    fixture.ledger.close();
    env.NODE_ENV = "production";
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test("production paid execution fails closed until the real provider is configured", async () => {
  const fixture = await createFixture({ localPaymentProvider: true });
  const previousMode = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    const snapshot = makeSnapshot(fixture.jobs);
    const imported = await dispatch(fixture.app, "POST", "/api/jobs/import", await signedImportBody(snapshot, digest("local-provider-import")));
    assert.equal(imported.statusCode, 201, JSON.stringify(imported.body));

    const job = (await fixture.jobs.get(snapshot.terms.jobId))!;
    const assignmentBody = await signedActionBody({
      job,
      signer: buyer,
      action: "ASSIGN_WORKER",
      epoch: job.task.epoch,
      payload: { worker: worker.address.toLowerCase() },
      body: { worker: worker.address },
    });
    assert.equal((await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/assign`, assignmentBody)).statusCode, 200);

    const inputBytes = Buffer.from("production provider guard");
    const request = {
      operationId: "must-not-submit-local-fixture",
      jobId: snapshot.terms.jobId,
      taskId: snapshot.task.taskId,
      worker: worker.address.toLowerCase(),
      epoch: 1,
      service: "batch-data-v1",
      inputDigest: digest(inputBytes),
      amount: "1",
      asset: "HBAR",
    };
    const executeBody = await signedActionBody({
      job: (await fixture.jobs.get(snapshot.terms.jobId))!,
      signer: worker,
      action: "SERVICE_EXECUTE",
      epoch: 1,
      payload: request,
      body: { ...request, inputBase64: inputBytes.toString("base64") },
    });
    const response = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/services/execute`, executeBody);
    assert.equal(response.statusCode, 503, JSON.stringify(response.body));
    assert.equal(response.body.error, "LIVE_PAYMENT_PROVIDER_REQUIRED");
    assert.equal(await fixture.ledger.getOperation(request.operationId), undefined);
    assert.equal(fixture.providerSubmissions(), 0);
  } finally {
    env.NODE_ENV = previousMode;
    fixture.ledger.close();
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test("signed chain-mode route dispatch covers assignment through payment reconciliation", async () => {
  const fixture = await createFixture();
  const previousMode = env.NODE_ENV;
  env.NODE_ENV = "test";
  try {
    const snapshot = makeSnapshot(fixture.jobs);
    await fixture.ledger.beginJobProvision(snapshot);
    await fixture.jobs.importInitial(snapshot);
    await fixture.ledger.completeJobProvision(snapshot);

    const assignBody = await signedActionBody({
      job: (await fixture.jobs.get(snapshot.terms.jobId))!,
      signer: buyer,
      action: "ASSIGN_WORKER",
      epoch: snapshot.task.epoch,
      payload: { worker: worker.address.toLowerCase() },
      body: { worker: worker.address },
    });
    const assigned = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/assign`, assignBody);
    assert.equal(assigned.statusCode, 200, JSON.stringify(assigned.body));
    assert.equal((await fixture.jobs.get(snapshot.terms.jobId))?.task.assignedWorker, worker.address.toLowerCase());

    const assignedJob = (await fixture.jobs.get(snapshot.terms.jobId))!;
    const candidate = {
      manifestDigest: digest("a"),
      manifestRef: "arkiv://route-test/checkpoint-1",
      artifactManifestDigest: digest("b"),
      schemaVersion: "checkpoint.v1",
      sequence: 1,
      previousAcceptedHead: null,
    };
    const candidatePayload = {
      taskId: assignedJob.task.taskId,
      worker: worker.address.toLowerCase(),
      epoch: assignedJob.task.epoch,
      acceptanceSpecHash: assignedJob.terms.task.milestones[0]!.acceptanceSpecHash,
      expectedHead: assignedJob.task.acceptedHead.manifestDigest,
      newHead: candidate,
    };
    const offer = {
      jobId: assignedJob.chainJobId!,
      taskId: assignedJob.chainTaskId!,
      termsHash: assignedJob.terms.termsHash,
      producer: worker.address.toLowerCase() as Hex,
      epoch: BigInt(assignedJob.task.epoch),
      milestone: assignedJob.task.nextMilestone,
      acceptanceSpecHash: candidatePayload.acceptanceSpecHash,
      expectedHead: candidatePayload.expectedHead,
      newHead: candidate.manifestDigest,
      manifestRef: candidate.manifestRef,
      sequence: BigInt(candidate.sequence),
      nonce: 91n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 240),
    };
    const offerSignature = await worker.signTypedData({
      domain: { name: "BATON Job Escrow", version: "1", chainId: 11155111, verifyingContract: escrow },
      types: OFFER_TYPES,
      primaryType: "MilestoneOffer",
      message: offer,
    });
    const authorizedCandidatePayload = { ...candidatePayload, contractOffer: { ...offer, signature: offerSignature } };
    const candidateBody = {
      ...candidate,
      taskId: candidatePayload.taskId,
      worker: worker.address,
      epoch: candidatePayload.epoch,
      acceptanceSpecHash: candidatePayload.acceptanceSpecHash,
      expectedHead: candidatePayload.expectedHead,
      offerNonce: offer.nonce.toString(),
      offerExpiry: Number(offer.expiry),
      offerSignature,
    };
    const workerAuthorizedCandidate = await signedActionBody({
      job: assignedJob,
      signer: worker,
      action: "CHECKPOINT_CANDIDATE",
      epoch: candidatePayload.epoch,
      payload: authorizedCandidatePayload,
      body: candidateBody,
      prefix: "workerAuth",
    });
    const acceptedCandidate = await signedActionBody({
      job: assignedJob,
      signer: buyer,
      action: "MILESTONE_ACCEPT",
      epoch: candidatePayload.epoch,
      payload: authorizedCandidatePayload,
      body: workerAuthorizedCandidate,
      prefix: "buyerAuth",
    });
    const accepted = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/checkpoints`, acceptedCandidate);
    assert.equal(accepted.statusCode, 200, JSON.stringify(accepted.body));
    assert.equal((await fixture.jobs.get(snapshot.terms.jobId))?.task.acceptedHead.manifestDigest, candidate.manifestDigest);

    const preHandoffOperation = {
      operationId: "paid-after-accepted-head",
      jobId: snapshot.terms.jobId,
      taskId: snapshot.task.taskId,
      worker: worker.address.toLowerCase(),
      epoch: 1,
      service: "batch-data-v1",
      inputDigest: digest("paid-work-not-in-checkpoint"),
      amount: "2",
      asset: "HBAR",
    };
    const preHandoffBody = await signedActionBody({
      job: (await fixture.jobs.get(snapshot.terms.jobId))!,
      signer: worker,
      action: "SERVICE_EXECUTE",
      epoch: 1,
      payload: preHandoffOperation,
      body: preHandoffOperation,
    });
    env.NODE_ENV = "production";
    const preHandoffPaid = await dispatch(
      fixture.app,
      "POST",
      `/api/jobs/${snapshot.terms.jobId}/services/execute`,
      preHandoffBody,
    );
    env.NODE_ENV = "test";
    assert.equal(preHandoffPaid.statusCode, 200, JSON.stringify(preHandoffPaid.body));
    assert.equal(preHandoffPaid.body.state, "OUTPUT_AVAILABLE");
    assert.equal(fixture.providerSubmissions(), 1);

    const acceptedJob = (await fixture.jobs.get(snapshot.terms.jobId))!;
    const drainBody = await signedActionBody({
      job: acceptedJob,
      signer: buyer,
      action: "DRAIN_TASK",
      epoch: acceptedJob.task.epoch,
      payload: {},
      body: {},
    });
    assert.equal((await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/drain`, drainBody)).statusCode, 200);

    const drainedJob = (await fixture.jobs.get(snapshot.terms.jobId))!;
    const takeoverFields = {
      successor: workerB.address.toLowerCase(),
      expectedHead: drainedJob.task.acceptedHead.manifestDigest,
      expectedEpoch: drainedJob.task.epoch,
      compatibilityReport: digest("c"),
    };
    const takeoverBody = await signedActionBody({
      job: drainedJob,
      signer: buyer,
      action: "TAKEOVER_TASK",
      epoch: takeoverFields.expectedEpoch,
      payload: takeoverFields,
      body: takeoverFields,
    });
    const blockedTakeover = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/takeover`, takeoverBody);
    assert.equal(blockedTakeover.statusCode, 409);
    assert.equal(blockedTakeover.body.error, "TAKEOVER_POLICY_RUNNER_REQUIRED");
    await fixture.gateway.takeover({
      jobId: snapshot.terms.jobId,
      ...takeoverFields,
    });
    const successorJob = (await fixture.jobs.get(snapshot.terms.jobId))!;
    assert.equal(successorJob.task.assignedWorker, workerB.address.toLowerCase());
    assert.equal(successorJob.task.epoch, 2);

    const pauseBody = await signedActionBody({
      job: successorJob,
      signer: buyer,
      action: "PAUSE_JOB",
      epoch: successorJob.task.epoch,
      payload: {},
      body: {},
    });
    assert.equal((await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/pause`, pauseBody)).statusCode, 200);
    const pausedJob = (await fixture.jobs.get(snapshot.terms.jobId))!;
    const resumeBody = await signedActionBody({
      job: pausedJob,
      signer: buyer,
      action: "RESUME_JOB",
      epoch: pausedJob.task.epoch,
      payload: {},
      body: {},
    });
    assert.equal((await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/resume`, resumeBody)).statusCode, 200);

    const signedTransaction = await worker.signTransaction({
      chainId: 11155111,
      nonce: 0,
      to: escrow,
      value: 0n,
      gas: 100_000n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
      data: encodeFunctionData({
        abi: parseAbi(["function claim(bytes32 jobId)"]),
        functionName: "claim",
        args: [snapshot.chainJobId!],
      }),
    });
    const claimFields = { worker: worker.address.toLowerCase(), transactionHash: keccak256(signedTransaction) };
    const claimBody = await signedActionBody({
      job: successorJob,
      signer: worker,
      action: "CLAIM_REWARD",
      epoch: successorJob.task.epoch,
      payload: claimFields,
      body: { worker: worker.address, epoch: successorJob.task.epoch, signedTransaction },
    });
    const claimed = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/claim`, claimBody);
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.body.amount, "3n");

    const serviceFields = {
      operationId: "route-service-operation",
      jobId: snapshot.terms.jobId,
      taskId: snapshot.task.taskId,
      worker: workerB.address.toLowerCase(),
      epoch: 2,
      service: "batch-data-v1",
      inputDigest: digest("d"),
      amount: "2",
      asset: "HBAR",
    };
    const listFields = { worker: workerB.address.toLowerCase(), epoch: 2, after: null, limit: 50 };
    const unsignedList = await dispatch(
      fixture.app,
      "POST",
      `/api/jobs/${snapshot.terms.jobId}/services/operations/list`,
      listFields,
    );
    assert.equal(unsignedList.statusCode, 409);
    assert.equal(unsignedList.body.error, "INVALID_AUTH_NONCE");
    const signedList = await signedActionBody({
      job: successorJob,
      signer: workerB,
      action: "SERVICE_OPERATIONS_LIST",
      epoch: 2,
      payload: listFields,
      body: listFields,
    });
    env.NODE_ENV = "production";
    const listed = await dispatch(
      fixture.app,
      "POST",
      `/api/jobs/${snapshot.terms.jobId}/services/operations/list`,
      signedList,
    );
    env.NODE_ENV = "test";
    assert.equal(listed.statusCode, 200, JSON.stringify(listed.body));
    const inherited = (listed.body.operations as Array<Record<string, unknown>>)
      .find((item) => item.operationId === preHandoffOperation.operationId);
    assert(inherited, "B can find an output settled after the accepted checkpoint was written");
    assert.equal(inherited.worker, worker.address.toLowerCase(), "A remains the original producer");
    assert.equal(inherited.epoch, 1);
    assert.equal(inherited.state, "OUTPUT_AVAILABLE");

    const reuseFields = {
      ...preHandoffOperation,
      worker: workerB.address.toLowerCase(),
      epoch: 2,
    };
    const reuseBody = await signedActionBody({
      job: successorJob,
      signer: workerB,
      action: "SERVICE_EXECUTE",
      epoch: 2,
      payload: reuseFields,
      body: reuseFields,
    });
    const reused = await dispatch(
      fixture.app,
      "POST",
      `/api/jobs/${snapshot.terms.jobId}/services/execute`,
      reuseBody,
    );
    assert.equal(reused.statusCode, 200, JSON.stringify(reused.body));
    assert.equal(reused.body.worker, worker.address.toLowerCase());
    assert.equal(reused.body.epoch, 1);
    assert.equal((reused.body.reusedBy as Array<{ worker: string; epoch: number }>)[0]?.worker, workerB.address.toLowerCase());
    assert.equal(fixture.providerSubmissions(), 1, "successor reuse does not resubmit the payment");

    const outputPayload = {
      operationId: preHandoffOperation.operationId,
      requestFingerprint: inherited.requestFingerprint,
      worker: workerB.address.toLowerCase(),
      epoch: 2,
    };
    const outputRequest = await signedActionBody({
      job: successorJob,
      signer: workerB,
      action: "SERVICE_OUTPUT_GET",
      epoch: 2,
      payload: outputPayload,
      body: { worker: workerB.address.toLowerCase(), epoch: 2 },
    });
    env.NODE_ENV = "production";
    const unsignedOutput = await dispatch(
      fixture.app,
      "POST",
      `/api/jobs/${snapshot.terms.jobId}/services/operations/${preHandoffOperation.operationId}/output`,
      { worker: workerB.address.toLowerCase(), epoch: 2 },
    );
    assert.equal(unsignedOutput.statusCode, 409);
    assert.equal(unsignedOutput.body.error, "INVALID_AUTH_NONCE");
    const paidOutput = await dispatch(
      fixture.app,
      "POST",
      `/api/jobs/${snapshot.terms.jobId}/services/operations/${preHandoffOperation.operationId}/output`,
      outputRequest,
    );
    env.NODE_ENV = "test";
    assert.equal(paidOutput.statusCode, 200, JSON.stringify(paidOutput.body));
    assert.equal(paidOutput.headers["content-type"], "application/octet-stream");
    assert.equal(paidOutput.headers["x-baton-operation-id"], preHandoffOperation.operationId);
    assert.equal(paidOutput.headers["x-baton-output-digest"], inherited.outputDigest);
    assert.deepEqual(paidOutput.rawBody, Buffer.from("fake-paid-output"));
    assert.equal(fixture.providerSubmissions(), 1, "output retrieval does not resubmit the provider payment");

    const staleOutputRequest = await signedActionBody({
      job: successorJob,
      signer: worker,
      action: "SERVICE_OUTPUT_GET",
      epoch: 1,
      payload: {
        operationId: preHandoffOperation.operationId,
        requestFingerprint: inherited.requestFingerprint,
        worker: worker.address.toLowerCase(),
        epoch: 1,
      },
      body: { worker: worker.address.toLowerCase(), epoch: 1 },
    });
    const staleOutput = await dispatch(
      fixture.app,
      "POST",
      `/api/jobs/${snapshot.terms.jobId}/services/operations/${preHandoffOperation.operationId}/output`,
      staleOutputRequest,
    );
    assert.equal(staleOutput.statusCode, 409);
    assert.equal(staleOutput.body.error, "WORKER_NOT_ASSIGNED");
    assert.equal(fixture.providerSubmissions(), 1, "stale A cannot retrieve B-authorized output");

    const executeBody = await signedActionBody({
      job: (await fixture.jobs.get(snapshot.terms.jobId))!,
      signer: workerB,
      action: "SERVICE_EXECUTE",
      epoch: 2,
      payload: serviceFields,
      body: serviceFields,
    });
    const executed = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/services/execute`, executeBody);
    assert.equal(executed.statusCode, 200);
    assert.equal(executed.body.state, "OUTPUT_AVAILABLE");

    const staleAFields = {
      ...serviceFields,
      operationId: "stale-a-after-takeover",
      worker: worker.address.toLowerCase(),
      epoch: 1,
      inputDigest: digest("stale-a-input"),
    };
    const staleABody = await signedActionBody({
      job: (await fixture.jobs.get(snapshot.terms.jobId))!,
      signer: worker,
      action: "SERVICE_EXECUTE",
      epoch: 1,
      payload: staleAFields,
      body: staleAFields,
    });
    const staleAResponse = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/services/execute`, staleABody);
    assert.equal(staleAResponse.statusCode, 409);
    assert.equal(staleAResponse.body.error, "WORKER_NOT_ASSIGNED");
    assert.equal(await fixture.ledger.getOperation(staleAFields.operationId), undefined);

    const operation = await fixture.ledger.getOperation(serviceFields.operationId);
    assert(operation);
    const reconcileFields = {
      operationId: operation.operationId,
      requestFingerprint: operation.requestFingerprint,
      worker: workerB.address.toLowerCase(),
      epoch: 2,
    };
    const reconcileBody = await signedActionBody({
      job: (await fixture.jobs.get(snapshot.terms.jobId))!,
      signer: workerB,
      action: "SERVICE_RECONCILE",
      epoch: 2,
      payload: reconcileFields,
      body: { worker: workerB.address, epoch: 2 },
    });
    env.NODE_ENV = "production";
    const unsignedReconcile = await dispatch(
      fixture.app,
      "POST",
      `/api/services/operations/${operation.operationId}/reconcile`,
      { worker: workerB.address, epoch: 2 },
    );
    assert.equal(unsignedReconcile.statusCode, 409);
    assert.equal(unsignedReconcile.body.error, "INVALID_AUTH_NONCE");
    const reconciled = await dispatch(fixture.app, "POST", `/api/services/operations/${operation.operationId}/reconcile`, reconcileBody);
    env.NODE_ENV = "test";
    assert.equal(reconciled.statusCode, 200, JSON.stringify(reconciled.body));
    assert.equal(reconciled.body.state, "OUTPUT_AVAILABLE");
  } finally {
    fixture.ledger.close();
    env.NODE_ENV = previousMode;
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test("buyer-signed cancel-drain reopens only after confirmed chain state remains assigned to A", async () => {
  const fixture = await createFixture();
  const previousMode = env.NODE_ENV;
  try {
    const snapshot = makeSnapshot(fixture.jobs);
    await fixture.ledger.beginJobProvision(snapshot);
    await fixture.jobs.importInitial(snapshot);
    await fixture.ledger.completeJobProvision(snapshot);
    await fixture.jobs.assign(snapshot.terms.jobId, worker.address as Hex);
    const drained = await fixture.gateway.drain(snapshot.terms.jobId);

    let checked = false;
    fixture.authority.assertCanCancelDrain = async (job, currentWorker) => {
      checked = true;
      assert.equal(job.terms.jobId, snapshot.terms.jobId);
      assert.equal(currentWorker.toLowerCase(), worker.address.toLowerCase());
      return false;
    };
    env.NODE_ENV = "test";

    const unsigned = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/cancel-drain`, {});
    assert.equal(unsigned.statusCode, 409);
    assert.equal(unsigned.body.error, "INVALID_AUTH_NONCE");
    assert.equal((await fixture.jobs.get(snapshot.terms.jobId))?.task.drained, true);

    const body = await signedActionBody({
      job: drained,
      signer: buyer,
      action: "CANCEL_DRAIN",
      epoch: drained.task.epoch,
      payload: {},
      body: {},
    });
    const response = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/cancel-drain`, body);
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(checked, true);
    const reopened = await fixture.jobs.get(snapshot.terms.jobId);
    assert.equal(reopened?.task.drained, false);
    assert.equal(reopened?.task.assignedWorker?.toLowerCase(), worker.address.toLowerCase());
    assert.equal(reopened?.task.epoch, 1);
  } finally {
    fixture.ledger.close();
    env.NODE_ENV = previousMode;
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test("chain-mode claim route requires a confirmed transaction before changing local credits", async () => {
  const fixture = await createFixture();
  const previousMode = env.NODE_ENV;
  try {
    const snapshot = makeSnapshot(fixture.jobs);
    await fixture.ledger.beginJobProvision(snapshot);
    await fixture.jobs.importInitial(snapshot);
    await fixture.ledger.completeJobProvision(snapshot);
    await fixture.jobs.assign(snapshot.terms.jobId, worker.address as Hex);

    env.NODE_ENV = "test";
    const response = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/claim`, {
      worker: worker.address,
      epoch: 1,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error, "INVALID_SIGNED_TRANSACTION");
    assert.equal((await fixture.jobs.get(snapshot.terms.jobId))?.credits.length, 0);
  } finally {
    fixture.ledger.close();
    env.NODE_ENV = previousMode;
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

async function createFixture(options: { localPaymentProvider?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "baton-api-routes-"));
  const jobs = new JobStore(join(root, "jobs.json"));
  const ledger = new OperationLedger(join(root, "payment-ledger.sqlite"));
  await jobs.init();
  await ledger.init();
  let importReads = 0;
  let chainDrained = false;
  let chainPaused = false;
  const authority = {
    assertCurrentWorker: async () => undefined,
    assertAssignedWorker: async () => undefined,
    assertReconciliationWorker: async () => undefined,
    assertImportableJob: async () => { importReads += 1; },
    assertAssignmentTransition: async (job: JobSnapshot, assignedWorker: Hex) =>
      job.task.epoch === 1 && job.task.assignedWorker?.toLowerCase() === assignedWorker.toLowerCase(),
    assertAssignmentConfirmed: async () => undefined,
    assertMilestoneTransition: async () => false,
    assertMilestoneAccepted: async () => undefined,
    assertPauseAllowed: async () => chainPaused,
    assertTaskPaused: async () => undefined,
    assertResumeAllowed: async () => chainPaused,
    assertTaskResumed: async () => undefined,
    confirmWorkerClaim: async (job: JobSnapshot, claimant: Hex) => {
      const credits = job.credits.filter((credit) => credit.worker.toLowerCase() === claimant.toLowerCase())
        .reduce((total, credit) => total + credit.amount, 0n);
      return { credits, withdrawnCredits: credits };
    },
    readTakeoverState: async (job: JobSnapshot) => ({
      assignedWorker: job.task.assignedWorker ?? ("0x" + "0".repeat(40)) as Hex,
      epoch: job.task.epoch,
      nextMilestone: job.task.nextMilestone,
      totalCredited: job.credits.reduce((total, credit) => total + credit.amount, 0n),
      acceptedHead: job.task.acceptedHead.manifestDigest,
      acceptedSequence: job.task.acceptedHead.sequence,
      acceptedManifestRef: job.task.acceptedHead.manifestRef,
      paused: chainPaused,
      drained: chainDrained,
      closed: false,
      expired: false,
      successorGranted: true,
    }),
    assertTaskDrained: async () => undefined,
    assertCanCancelDrain: async () => chainDrained,
    assertDrainCancelled: async () => { chainDrained = false; },
  } as unknown as JobAuthorityReader & SepoliaAuthorityReader;
  const mutationWriter: EscrowMutationWriter = {
    async assign() {},
    async acceptMilestone() {},
    async drain() { chainDrained = true; },
    async cancelDrain() { chainDrained = false; },
    async takeover() { return undefined; },
    async pause() { chainPaused = true; },
    async resume() { chainPaused = false; },
    async claim() { return undefined; },
  };
  let providerSubmissionCount = 0;
  const localProvider = new LocalPaymentProvider();
  const paidOutput = Buffer.from("fake-paid-output");
  const providerResults = new Map<string, PaymentResult>();
  const provider = options.localPaymentProvider ? localProvider : {
    async submit(request: Parameters<LocalPaymentProvider["submit"]>[0]) {
      providerSubmissionCount += 1;
      const base = await localProvider.submit(request);
      const result = { ...base, outputDigest: sha256Bytes(paidOutput), outputRef: `test://paid-output/${request.operationId}` };
      providerResults.set(request.operationId, result);
      return result;
    },
    async reconcile(operation: Parameters<LocalPaymentProvider["reconcile"]>[0]) {
      const result = await localProvider.reconcile(operation);
      return result.status === "settled"
        ? { status: "settled" as const, result: providerResults.get(operation.operationId) ?? result.result }
        : result;
    },
    async retrieveOutput(operation: Parameters<LocalPaymentProvider["reconcile"]>[0]) {
      if (!providerResults.has(operation.operationId)) throw new Error("PAID_OUTPUT_NOT_AVAILABLE");
      return paidOutput;
    },
  };
  const gateway = new Gateway(jobs, ledger, provider, authority, {
    verifyCandidate: async () => undefined,
  }, {
    assignTask: (job, assignedWorker) => mutationWriter.assign(job, assignedWorker),
    acceptMilestone: (job, offer, signature) => mutationWriter.acceptMilestone(job, offer, signature),
    pause: (job) => mutationWriter.pause(job),
    resume: (job) => mutationWriter.resume(job),
  });
  const app = createApp({ jobs, ledger, gateway, authority, mutationWriter });
  return {
    root,
    jobs,
    ledger,
    gateway,
    app,
    authority,
    importReads: () => importReads,
    providerSubmissions: () => providerSubmissionCount,
  };
}

function makeSnapshot(jobs: JobStore): JobSnapshot {
  const snapshot = jobs.prepareCreate({
    chainJobId: ("0x" + "1".repeat(64)) as Hex,
    chainTaskId: ("0x" + "2".repeat(64)) as Hex,
    buyer: buyer.address as Hex,
    rewardToken: ("0x" + "3".repeat(40)) as Hex,
    verifier: ("0x" + "4".repeat(40)) as Hex,
    rewards: [3n, 4n],
    serviceBudget: 5n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 3n,
  });
  return snapshot;
}

async function signedImportBody(snapshot: JobSnapshot, nonce: Hex): Promise<Record<string, unknown>> {
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const message = gatewayActionMessage({
    action: "IMPORT_JOB",
    job: snapshot,
    actor: buyer.address,
    epoch: 0,
    payload: { snapshotDigest: digest(snapshot) },
    nonce,
    expiry,
  });
  const authSignature = await buyer.signTypedData({
    domain: gatewayActionDomain(11155111, escrow),
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message,
  });
  return { snapshot: serialise(snapshot), authNonce: nonce, authExpiry: expiry, authSignature };
}

async function signedActionBody(input: {
  job: JobSnapshot;
  signer: ReturnType<typeof privateKeyToAccount>;
  action: string;
  epoch: number;
  payload: unknown;
  body: Record<string, unknown>;
  prefix?: string;
}): Promise<Record<string, unknown>> {
  const prefix = input.prefix ?? "auth";
  const nonce = digest(`route-auth-${authNonceCounter++}`);
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const message = gatewayActionMessage({
    action: input.action,
    job: input.job,
    actor: input.signer.address,
    epoch: input.epoch,
    payload: input.payload,
    nonce,
    expiry,
  });
  const authSignature = await input.signer.signTypedData({
    domain: gatewayActionDomain(11155111, escrow),
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message,
  });
  return {
    ...input.body,
    [`${prefix}Nonce`]: nonce,
    [`${prefix}Expiry`]: expiry,
    [`${prefix}Signature`]: authSignature,
  };
}

async function dispatch(app: Express, method: string, url: string, body: unknown): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  rawBody: Buffer;
}> {
  const bytes = Buffer.from(JSON.stringify(body));
  const request = Object.assign(Readable.from([bytes]), {
    method,
    url,
    originalUrl: url,
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
    },
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    socket: { encrypted: false, remoteAddress: "127.0.0.1", remotePort: 1, localAddress: "127.0.0.1", localPort: 80 },
    connection: undefined,
  });
  request.connection = request.socket;

  const responseEvents = new EventEmitter();
  const headers = new Map<string, unknown>();
  const chunks: Buffer[] = [];
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    finished: false,
    writableEnded: false,
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    hasHeader(name: string) { return headers.has(name.toLowerCase()); },
    removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    write(chunk: string | Uint8Array) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk?: string | Uint8Array, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined));
      this.headersSent = true;
      this.finished = true;
      this.writableEnded = true;
      (typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
      responseEvents.emit("finish");
      return this;
    },
  });
  response.on = responseEvents.on.bind(responseEvents);
  response.once = responseEvents.once.bind(responseEvents);
  response.emit = responseEvents.emit.bind(responseEvents);

  return new Promise((resolve, reject) => {
    response.once("finish", () => {
      const rawBody = Buffer.concat(chunks);
      let parsedBody: Record<string, unknown> = {};
      try {
        parsedBody = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
      } catch {
        // Binary responses are inspected through rawBody.
      }
      resolve({
        statusCode: response.statusCode,
        body: parsedBody,
        headers: Object.fromEntries([...headers.entries()].map(([name, value]) => [name, String(value)])),
        rawBody,
      });
    });
    try {
      app.handle(request as never, response as never, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function sha256Bytes(bytes: Uint8Array): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
}
