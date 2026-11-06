import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayActionDomain, gatewayActionMessage, GATEWAY_ACTION_TYPES, recoverGatewayActionActor } from "../../../src/chain/gatewayAction.js";
import { digest, paymentIntentFingerprint, serialise, type GatewayOperation, type JobSnapshot } from "../../../src/protocol/v1.js";
import { executeReusablePaidOperation, listReusablePaidOperations, recoverReusablePaidOperation, retrieveReusablePaidOutput } from "./takeoverPolicyClient.js";

const b = privateKeyToAccount("0x" + "22".repeat(32));
const a = privateKeyToAccount("0x" + "11".repeat(32));
const escrow = ("0x" + "55".repeat(20)) as `0x${string}`;

test("B signs reusable-operation discovery and validates original intent attribution", async () => {
  const job = currentJob();
  const operation = reusableOperation(job);
  const page = { operations: [operation], nextCursor: null };
  const result = await listReusablePaidOperations({
    apiUrl: "http://127.0.0.1:4000",
    escrowAddress: escrow,
    chainId: 11155111,
    job,
    account: b,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).pathname, "/api/jobs/job-1/services/operations/list");
      assert.equal(request.method, "POST");
      const body = await request.json() as Record<string, unknown>;
      const payload = { worker: b.address.toLowerCase(), epoch: 2, after: null, limit: 50 };
      const message = gatewayActionMessage({
        action: "SERVICE_OPERATIONS_LIST",
        job,
        actor: b.address,
        epoch: 2,
        payload,
        nonce: body.authNonce as `0x${string}`,
        expiry: Number(body.authExpiry),
      });
      assert.equal(await recoverGatewayActionActor({
        chainId: 11155111,
        verifyingContract: escrow,
        message,
        signature: body.authSignature as `0x${string}`,
      }), b.address);
      return Response.json(serialise(page));
    },
  });

  assert.equal(result.operations[0]?.operationId, operation.operationId);
  assert.equal(result.operations[0]?.worker, a.address.toLowerCase());
  assert.equal(result.operations[0]?.epoch, 1);
});

test("B rejects reusable-operation pages whose immutable intent no longer matches", async () => {
  const job = currentJob();
  const operation = reusableOperation(job);
  operation.requestFingerprint = digest("altered intent");
  await assert.rejects(listReusablePaidOperations({
    apiUrl: "http://127.0.0.1:4000",
    escrowAddress: escrow,
    chainId: 11155111,
    job,
    account: b,
    fetchImpl: async () => Response.json(serialise({ operations: [operation], nextCursor: null })),
  }), /REUSABLE_OPERATION_BINDING_MISMATCH/);
});

test("B reuses the listed operation with a signed request and retains A as original producer", async () => {
  const job = currentJob();
  const operation = reusableOperation(job);
  const reused = {
    ...operation,
    reusedBy: [{ worker: b.address.toLowerCase(), epoch: 2, at: "2026-11-06T10:00:02.000Z" }],
  };
  const result = await executeReusablePaidOperation({
    apiUrl: "http://127.0.0.1:4000",
    escrowAddress: escrow,
    chainId: 11155111,
    job,
    operation,
    account: b,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).pathname, "/api/jobs/job-1/services/execute");
      const body = await request.json() as Record<string, unknown>;
      const payload = {
        operationId: operation.operationId,
        jobId: job.terms.jobId,
        taskId: job.task.taskId,
        worker: b.address.toLowerCase(),
        epoch: 2,
        service: operation.service,
        inputDigest: operation.inputDigest,
        amount: operation.amount.toString(),
        asset: operation.asset,
      };
      const message = gatewayActionMessage({
        action: "SERVICE_EXECUTE",
        job,
        actor: b.address,
        epoch: 2,
        payload,
        nonce: body.authNonce as `0x${string}`,
        expiry: Number(body.authExpiry),
      });
      assert.equal(await recoverGatewayActionActor({
        chainId: 11155111,
        verifyingContract: escrow,
        message,
        signature: body.authSignature as `0x${string}`,
      }), b.address);
      assert.equal(body.operationId, operation.operationId);
      assert.equal(body.amount, "2");
      return Response.json(serialise(reused));
    },
  });
  assert.equal(result.worker, a.address.toLowerCase());
  assert.equal(result.epoch, 1);
  assert.equal(result.reusedBy?.[0]?.worker, b.address.toLowerCase());
  assert.equal(result.outputRef, operation.outputRef);
});

test("B signs paid-output retrieval and verifies the returned bytes against the ledger digest", async () => {
  const job = currentJob();
  const operation = reusableOperation(job);
  const output = Buffer.from("paid output");
  operation.outputDigest = sha256Bytes(output);
  let requests = 0;
  const bytes = await retrieveReusablePaidOutput({
    apiUrl: "http://127.0.0.1:4000",
    escrowAddress: escrow,
    chainId: 11155111,
    job,
    operation,
    account: b,
    fetchImpl: async (input, init) => {
      requests += 1;
      const request = new Request(input, init);
      assert.equal(new URL(request.url).pathname, `/api/jobs/${job.terms.jobId}/services/operations/${operation.operationId}/output`);
      assert.equal(request.method, "POST");
      const body = await request.json() as Record<string, unknown>;
      const payload = {
        operationId: operation.operationId,
        requestFingerprint: operation.requestFingerprint,
        worker: b.address.toLowerCase(),
        epoch: 2,
      };
      const message = gatewayActionMessage({
        action: "SERVICE_OUTPUT_GET",
        job,
        actor: b.address,
        epoch: 2,
        payload,
        nonce: body.authNonce as `0x${string}`,
        expiry: Number(body.authExpiry),
      });
      assert.equal(await recoverGatewayActionActor({
        chainId: 11155111,
        verifyingContract: escrow,
        message,
        signature: body.authSignature as `0x${string}`,
      }), b.address);
      return new Response(output, {
        headers: {
          "content-type": "application/octet-stream",
          "x-baton-operation-id": operation.operationId,
          "x-baton-output-digest": operation.outputDigest,
        },
      });
    },
  });

  assert.equal(requests, 1);
  assert.deepEqual(Buffer.from(bytes), output);
  await assert.rejects(retrieveReusablePaidOutput({
    apiUrl: "http://127.0.0.1:4000",
    escrowAddress: escrow,
    chainId: 11155111,
    job,
    operation,
    account: b,
    fetchImpl: async () => new Response(Buffer.from("tampered"), {
      headers: {
        "content-type": "application/octet-stream",
        "x-baton-operation-id": operation.operationId,
        "x-baton-output-digest": operation.outputDigest!,
      },
    }),
  }), /PAID_OUTPUT_DIGEST_MISMATCH/);
});

test("B recovers one paid operation end to end through discovery, reuse, and byte retrieval", async () => {
  const job = currentJob();
  const operation = reusableOperation(job);
  const output = Buffer.from("paid output after restart");
  operation.outputDigest = sha256Bytes(output);
  const reused = {
    ...operation,
    reusedBy: [{ worker: b.address.toLowerCase(), epoch: 2, at: "2026-11-06T10:05:00.000Z" }],
  };
  let requests = 0;
  const recovered = await recoverReusablePaidOperation({
    apiUrl: "http://127.0.0.1:4000",
    escrowAddress: escrow,
    chainId: 11155111,
    job,
    operationId: operation.operationId,
    account: b,
    fetchImpl: async (input, init) => {
      requests += 1;
      const request = new Request(input, init);
      const body = await request.json() as Record<string, unknown>;
      const path = new URL(request.url).pathname;
      let action: string;
      let payload: Record<string, unknown>;
      if (path.endsWith("/services/operations/list")) {
        action = "SERVICE_OPERATIONS_LIST";
        payload = { worker: b.address.toLowerCase(), epoch: 2, after: null, limit: 50 };
        assert.deepEqual(requests, 1);
        return Response.json(serialise({ operations: [operation], nextCursor: null }));
      }
      if (path.endsWith("/services/execute")) {
        action = "SERVICE_EXECUTE";
        payload = {
          operationId: operation.operationId,
          jobId: job.terms.jobId,
          taskId: job.task.taskId,
          worker: b.address.toLowerCase(),
          epoch: 2,
          service: operation.service,
          inputDigest: operation.inputDigest,
          amount: operation.amount.toString(),
          asset: operation.asset,
        };
        assert.deepEqual(requests, 2);
        return Response.json(serialise(reused));
      }
      assert.equal(path, `/api/jobs/${job.terms.jobId}/services/operations/${operation.operationId}/output`);
      action = "SERVICE_OUTPUT_GET";
      payload = {
        operationId: operation.operationId,
        requestFingerprint: operation.requestFingerprint,
        worker: b.address.toLowerCase(),
        epoch: 2,
      };
      assert.deepEqual(requests, 3);
      const message = gatewayActionMessage({
        action,
        job,
        actor: b.address,
        epoch: 2,
        payload,
        nonce: body.authNonce as `0x${string}`,
        expiry: Number(body.authExpiry),
      });
      assert.equal(await recoverGatewayActionActor({
        chainId: 11155111,
        verifyingContract: escrow,
        message,
        signature: body.authSignature as `0x${string}`,
      }), b.address);
      return new Response(output, {
        headers: {
          "content-type": "application/octet-stream",
          "x-baton-operation-id": operation.operationId,
          "x-baton-output-digest": operation.outputDigest,
        },
      });
    },
  });

  assert.equal(requests, 3);
  assert.equal(recovered.operation.reusedBy?.[0]?.worker, b.address.toLowerCase());
  assert.deepEqual(Buffer.from(recovered.bytes), output);
});

test("a stale worker cannot request the successor's reusable operation page", async () => {
  let requests = 0;
  await assert.rejects(listReusablePaidOperations({
    apiUrl: "http://127.0.0.1:4000",
    escrowAddress: escrow,
    chainId: 11155111,
    job: currentJob(),
    account: a,
    fetchImpl: async () => { requests += 1; return Response.json({ operations: [], nextCursor: null }); },
  }), /WORKER_NOT_ASSIGNED/);
  assert.equal(requests, 0);
});

function currentJob(): JobSnapshot {
  return {
    terms: { jobId: "job-1", task: { taskId: "task-1" } },
    task: { taskId: "task-1", assignedWorker: b.address.toLowerCase(), epoch: 2 },
    servicePolicy: {
      providerId: "local-fixture",
      network: "hedera:testnet",
      payee: ("0x" + "00".repeat(20)) as `0x${string}`,
      asset: "HBAR",
      budget: 10n,
      perRequestCap: 5n,
      approvedServices: ["batch-data-v1"],
      policyVersion: "service-policy.v1",
    },
  } as unknown as JobSnapshot;
}

function sha256Bytes(bytes: Uint8Array): `0x${string}` {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function reusableOperation(job: JobSnapshot): GatewayOperation {
  const operation = {
    operationId: "paid-before-checkpoint",
    jobId: job.terms.jobId,
    taskId: job.terms.task.taskId,
    worker: a.address.toLowerCase(),
    epoch: 1,
    service: "batch-data-v1",
    inputDigest: digest("paid input"),
    providerId: job.servicePolicy.providerId,
    network: job.servicePolicy.network,
    payee: job.servicePolicy.payee,
    policyVersion: job.servicePolicy.policyVersion,
    approvedPolicyHash: digest(job.servicePolicy),
    amount: 2n,
    asset: job.servicePolicy.asset,
    state: "OUTPUT_AVAILABLE",
    nonce: "provider-nonce",
    createdAt: "2026-11-06T10:00:00.000Z",
    updatedAt: "2026-11-06T10:00:01.000Z",
    requestFingerprint: "" as `0x${string}`,
    providerReceipt: "fixture-receipt",
    settledAmount: 2n,
    outputDigest: digest("paid output"),
    outputRef: "arkiv://paid-output/fixture",
  } satisfies GatewayOperation;
  operation.requestFingerprint = paymentIntentFingerprint({
    jobId: operation.jobId,
    taskId: operation.taskId,
    providerId: operation.providerId,
    network: operation.network,
    service: operation.service,
    inputDigest: operation.inputDigest,
    amount: operation.amount,
    asset: operation.asset,
    payee: operation.payee,
    policyVersion: operation.policyVersion,
    approvedPolicyHash: operation.approvedPolicyHash,
  });
  return operation;
}
