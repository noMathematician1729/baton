import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Express } from "express";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayActionDomain, gatewayActionMessage, GATEWAY_ACTION_TYPES } from "./chain/gatewayAction.js";
import { domain as escrowDomain, OFFER_TYPES, TAKEOVER_TYPES } from "./chain/signing.js";
import type { EscrowMutationWriter } from "./chain/sepoliaEscrowWriter.js";
import { parseInitialChainJobSnapshot } from "./chain/chainJobImport.js";
import type { JobAuthorityReader } from "./chain/sepoliaAuthority.js";
import { JobStore } from "./domain/jobs/jobStore.js";
import { digest, serialise, type Hex, type JobSnapshot } from "./protocol/v1.js";
import { Gateway, LocalPaymentProvider } from "./services/gateway/gateway.js";
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

test("production API permits only buyer-signed initial chain-job import", async () => {
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

    for (const route of [
      `/api/jobs/${snapshot.terms.jobId}/assign`,
      `/api/jobs/${snapshot.terms.jobId}/checkpoints`,
      `/api/jobs/${snapshot.terms.jobId}/drain`,
      `/api/jobs/${snapshot.terms.jobId}/takeover`,
      `/api/jobs/${snapshot.terms.jobId}/pause`,
      `/api/jobs/${snapshot.terms.jobId}/resume`,
      `/api/jobs/${snapshot.terms.jobId}/claim`,
      `/api/jobs/${snapshot.terms.jobId}/services/execute`,
      `/api/services/operations/route-test/reconcile`,
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

test("production lifecycle route opens only when the chain writer is configured", async () => {
  const fixture = await createFixture(true);
  const previousMode = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    const snapshot = makeSnapshot(fixture.jobs);
    await fixture.jobs.importInitial(snapshot);
    const assignBody = await signedActionBody({
      job: snapshot,
      signer: buyer,
      action: "ASSIGN_WORKER",
      epoch: 0,
      payload: { worker: worker.address.toLowerCase() },
      body: { worker: worker.address },
    });
    const assigned = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/assign`, assignBody);
    assert.equal(assigned.statusCode, 200, JSON.stringify(assigned.body));
    assert.equal((await fixture.jobs.get(snapshot.terms.jobId))?.task.assignedWorker, worker.address.toLowerCase());

    const fixturePayment = await dispatch(fixture.app, "POST", "/api/services/operations/fixture/reconcile", {});
    assert.equal(fixturePayment.statusCode, 503, "production still rejects the local fixture provider route");
  } finally {
    fixture.ledger.close();
    env.NODE_ENV = previousMode;
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test("signed chain-mode route dispatch covers assignment through payment reconciliation", async () => {
  const fixture = await createFixture(true);
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
    const candidateBody = {
      ...candidate,
      taskId: candidatePayload.taskId,
      worker: worker.address,
      epoch: candidatePayload.epoch,
      acceptanceSpecHash: candidatePayload.acceptanceSpecHash,
      expectedHead: candidatePayload.expectedHead,
    };
    const offer = {
      jobId: assignedJob.chainJobId!,
      taskId: assignedJob.chainTaskId!,
      termsHash: assignedJob.terms.termsHash,
      producer: worker.address,
      epoch: BigInt(candidatePayload.epoch),
      milestone: assignedJob.task.nextMilestone,
      acceptanceSpecHash: candidatePayload.acceptanceSpecHash,
      expectedHead: candidatePayload.expectedHead,
      newHead: candidate.manifestDigest,
      manifestRef: candidate.manifestRef,
      sequence: BigInt(candidate.sequence),
      nonce: 22n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 120),
    };
    const offerSignature = await worker.signTypedData({
      domain: escrowDomain(11155111, escrow),
      types: OFFER_TYPES,
      primaryType: "MilestoneOffer",
      message: offer,
    });
    Object.assign(candidateBody, { offerNonce: offer.nonce.toString(), offerExpiry: offer.expiry.toString(), offerSignature });
    const workerAuthorizedCandidate = await signedActionBody({
      job: assignedJob,
      signer: worker,
      action: "CHECKPOINT_CANDIDATE",
      epoch: candidatePayload.epoch,
      payload: candidatePayload,
      body: candidateBody,
      prefix: "workerAuth",
    });
    const acceptedCandidate = await signedActionBody({
      job: assignedJob,
      signer: buyer,
      action: "MILESTONE_ACCEPT",
      epoch: candidatePayload.epoch,
      payload: candidatePayload,
      body: workerAuthorizedCandidate,
      prefix: "buyerAuth",
    });
    const accepted = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/checkpoints`, acceptedCandidate);
    assert.equal(accepted.statusCode, 200);
    assert.equal((await fixture.jobs.get(snapshot.terms.jobId))?.task.acceptedHead.manifestDigest, candidate.manifestDigest);

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
    const ack = {
      jobId: drainedJob.chainJobId!,
      taskId: drainedJob.chainTaskId!,
      termsHash: drainedJob.terms.termsHash,
      successor: workerB.address,
      epoch: BigInt(takeoverFields.expectedEpoch),
      expectedHead: takeoverFields.expectedHead,
      compatibilityReport: takeoverFields.compatibilityReport,
      servicePolicy: digest(drainedJob.servicePolicy),
      nonce: 33n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 120),
    };
    const ackSignature = await workerB.signTypedData({
      domain: escrowDomain(11155111, escrow),
      types: TAKEOVER_TYPES,
      primaryType: "TakeoverAck",
      message: ack,
    });
    const takeoverBody = await signedActionBody({
      job: drainedJob,
      signer: buyer,
      action: "TAKEOVER_TASK",
      epoch: takeoverFields.expectedEpoch,
      payload: takeoverFields,
      body: { ...takeoverFields, ackNonce: ack.nonce.toString(), ackExpiry: ack.expiry.toString(), ackSignature },
    });
    assert.equal((await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/takeover`, takeoverBody)).statusCode, 200);
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

    const claimTransaction = "0x1234" as Hex;
    const claimBody = await signedActionBody({
      job: (await fixture.jobs.get(snapshot.terms.jobId))!,
      signer: worker,
      action: "CLAIM_REWARD",
      epoch: 1,
      payload: { worker: worker.address.toLowerCase(), transactionHash: keccak256(claimTransaction) },
      body: { worker: worker.address, epoch: 1, signedTransaction: claimTransaction },
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
    const reconciled = await dispatch(fixture.app, "POST", `/api/services/operations/${operation.operationId}/reconcile`, reconcileBody);
    assert.equal(reconciled.statusCode, 200);
    assert.equal(reconciled.body.state, "OUTPUT_AVAILABLE");
  } finally {
    fixture.ledger.close();
    env.NODE_ENV = previousMode;
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test("chain-mode worker action route rejects unsigned claims before crediting", async () => {
  const fixture = await createFixture();
  const previousMode = env.NODE_ENV;
  try {
    const snapshot = makeSnapshot(fixture.jobs);
    await fixture.ledger.beginJobProvision(snapshot);
    await fixture.jobs.importInitial(snapshot);
    await fixture.ledger.completeJobProvision(snapshot);
    await fixture.jobs.assign(snapshot.terms.jobId, worker.address as Hex);

    // Exercise signed-action dispatch in chain mode without opening a TCP listener.
    env.NODE_ENV = "test";
    const response = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/claim`, {
      worker: worker.address,
      epoch: 1,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error, "INVALID_AUTH_NONCE");
    assert.equal((await fixture.jobs.get(snapshot.terms.jobId))?.credits.length, 0);
  } finally {
    fixture.ledger.close();
    env.NODE_ENV = previousMode;
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

async function createFixture(withMutationWriter = false) {
  const root = await mkdtemp(join(tmpdir(), "baton-api-routes-"));
  const jobs = new JobStore(join(root, "jobs.json"));
  const ledger = new OperationLedger(join(root, "payment-ledger.sqlite"));
  await jobs.init();
  await ledger.init();
  let importReads = 0;
  const authority = {
    assertCurrentWorker: async () => undefined,
    assertAssignedWorker: async () => undefined,
    assertImportableJob: async () => { importReads += 1; },
    assertSnapshotCurrent: async () => undefined,
  } as unknown as JobAuthorityReader;
  const mutationWriter: EscrowMutationWriter | undefined = withMutationWriter ? {
    assign: async () => undefined,
    acceptMilestone: async () => undefined,
    drain: async () => undefined,
    takeover: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    claim: async () => undefined,
  } : undefined;
  const gateway = new Gateway(jobs, ledger, new LocalPaymentProvider(), authority, {
    verifyCandidate: async () => undefined,
  }, mutationWriter, 11155111, escrow);
  const app = createApp({ jobs, ledger, gateway });
  return { root, jobs, ledger, gateway, app, importReads: () => importReads };
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
      resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
    });
    try {
      app.handle(request as never, response as never, reject);
    } catch (error) {
      reject(error);
    }
  });
}
