import { createHash, randomBytes } from "node:crypto";
import { artifactManifestDigest } from "../../../packages/checkpoint/src/index.js";
import { MAX_ARTIFACT_BYTES } from "../../../packages/checkpoint/src/limits.js";
import type { RecoveredAcceptedPackage } from "../../../packages/storage/src/recovery.js";
import {
  deserialise,
  digest,
  paymentIntentFingerprint,
  type GatewayOperation,
  type Hex,
  type JobSnapshot,
  type OperationPageCursor,
  type ReusableOperationPage,
} from "../../../src/protocol/v1.js";
import { gatewayActionDomain, gatewayActionMessage, GATEWAY_ACTION_TYPES } from "../../../src/chain/gatewayAction.js";
import { domain, TAKEOVER_TYPES, type TakeoverAck } from "../../../src/chain/signing.js";
import type { privateKeyToAccount } from "viem/accounts";

type WorkerAccount = ReturnType<typeof privateKeyToAccount>;

export async function sendWorkerHeartbeat(input: {
  apiUrl: string;
  escrowAddress: Hex;
  chainId: number;
  job: JobSnapshot;
  account: WorkerAccount;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const worker = input.account.address.toLowerCase() as typeof input.account.address;
  if (input.job.task.assignedWorker?.toLowerCase() !== worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
  const payload = { taskId: input.job.task.taskId, worker, epoch: input.job.task.epoch };
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const nonce = randomHex32();
  const authSignature = await input.account.signTypedData({
    domain: gatewayActionDomain(input.chainId, input.escrowAddress),
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message: gatewayActionMessage({
      action: "WORKER_HEARTBEAT",
      job: input.job,
      actor: worker,
      epoch: input.job.task.epoch,
      payload,
      nonce,
      expiry,
    }),
  });
  await postJson(input.apiUrl, `/api/jobs/${encodeURIComponent(input.job.terms.jobId)}/heartbeat`, {
    ...payload,
    authNonce: nonce,
    authExpiry: expiry,
    authSignature,
  }, input.fetchImpl ?? fetch);
}

export function startWorkerHeartbeatLoop(input: Omit<Parameters<typeof sendWorkerHeartbeat>[0], "job"> & {
  getJob(): Promise<JobSnapshot>;
  intervalMs: number;
  onError?(error: unknown): void;
}): () => void {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1_000) throw new Error("HEARTBEAT_INTERVAL_INVALID");
  let stopped = false;
  let sending = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const tick = async () => {
    if (stopped || sending) return;
    sending = true;
    try {
      const job = await input.getJob();
      await sendWorkerHeartbeat({
        apiUrl: input.apiUrl,
        escrowAddress: input.escrowAddress,
        chainId: input.chainId,
        account: input.account,
        fetchImpl: input.fetchImpl,
        job,
      });
    } catch (error) {
      try {
        input.onError?.(error);
      } catch {
        // A logging callback must not keep the heartbeat loop alive after it is stopped.
      }
      if (error instanceof Error && ["WORKER_NOT_ASSIGNED", "STALE_EPOCH", "GATEWAY_DRAINED"].includes(error.message)) {
        stop();
      }
    } finally {
      sending = false;
    }
  };
  timer = setInterval(() => { void tick(); }, input.intervalMs);
  void tick();
  return stop;
}

/** Create B's exact-head EIP-712 acknowledgement only after accepted-package recovery succeeds. */
export async function submitRecoveredCheckpointAcknowledgement(input: {
  apiUrl: string;
  escrowAddress: Hex;
  chainId: number;
  job: JobSnapshot;
  recovered: RecoveredAcceptedPackage;
  account: WorkerAccount;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { job, recovered, account } = input;
  if (!job.chainJobId || !job.chainTaskId) throw new Error("CHAIN_JOB_BINDING_REQUIRED");
  if (!job.task.drained || job.task.status !== "DRAINED") throw new Error("TASK_NOT_DRAINED");
  const head = job.task.acceptedHead;
  const manifest = recovered.manifest;
  if (recovered.manifestDigest.toLowerCase() !== head.manifestDigest.toLowerCase()
    || recovered.manifestRef.toLowerCase() !== head.manifestRef.toLowerCase()
    || manifest.jobId !== job.terms.jobId || manifest.taskId !== job.task.taskId
    || manifest.schemaVersion !== head.schemaVersion
    || manifest.sequence !== head.sequence
    || (manifest.previousAcceptedHead?.toLowerCase() ?? null) !== (head.previousAcceptedHead?.toLowerCase() ?? null)
    || artifactManifestDigest(manifest).toLowerCase() !== head.artifactManifestDigest.toLowerCase()) {
    throw new Error("RECOVERED_CHECKPOINT_NOT_CURRENT_HEAD");
  }
  if (!job.task.assignedWorker || account.address.toLowerCase() === job.task.assignedWorker.toLowerCase()) {
    throw new Error("SUCCESSOR_SIGNER_INVALID");
  }

  const ack: TakeoverAck = {
    jobId: job.chainJobId,
    taskId: job.chainTaskId,
    termsHash: job.terms.termsHash,
    successor: account.address,
    epoch: BigInt(job.task.epoch),
    expectedHead: head.manifestDigest,
    compatibilityReport: digest({
      manifestDigest: recovered.manifestDigest,
      adapter: manifest.adapter,
      artifacts: recovered.artifacts.map(({ artifactId, contentDigest, bytes }) => ({
        artifactId,
        contentDigest,
        byteLength: bytes.byteLength,
      })),
      tools: manifest.tools,
    }),
    servicePolicy: digest(job.servicePolicy),
    nonce: BigInt(`0x${randomBytes(32).toString("hex")}`),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 120),
  };
  const signature = await account.signTypedData({
    domain: domain(input.chainId, input.escrowAddress),
    types: TAKEOVER_TYPES,
    primaryType: "TakeoverAck",
    message: ack,
  });
  await postJson(input.apiUrl, `/api/jobs/${encodeURIComponent(job.terms.jobId)}/takeover-ack`, {
    ...ack,
    epoch: Number(ack.epoch),
    nonce: ack.nonce.toString(),
    expiry: Number(ack.expiry),
    signature,
  }, input.fetchImpl ?? fetch);
}

/** Find output-ready purchases from the buyer gateway's durable ledger after a handoff. */
export async function listReusablePaidOperations(input: {
  apiUrl: string;
  escrowAddress: Hex;
  chainId: number;
  job: JobSnapshot;
  account: WorkerAccount;
  after?: OperationPageCursor;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<ReusableOperationPage> {
  const { job, account } = input;
  const worker = account.address.toLowerCase() as typeof account.address;
  if (job.task.assignedWorker?.toLowerCase() !== worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
  if (!Number.isSafeInteger(job.task.epoch) || job.task.epoch < 1) throw new Error("INVALID_EPOCH");
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("OPERATION_PAGE_LIMIT_INVALID");
  const after = input.after ?? null;
  const payload = { worker, epoch: job.task.epoch, after, limit };
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const nonce = randomHex32();
  const authSignature = await account.signTypedData({
    domain: gatewayActionDomain(input.chainId, input.escrowAddress),
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message: gatewayActionMessage({
      action: "SERVICE_OPERATIONS_LIST",
      job,
      actor: worker,
      epoch: job.task.epoch,
      payload,
      nonce,
      expiry,
    }),
  });
  const raw = await postJsonResult(input.apiUrl, `/api/jobs/${encodeURIComponent(job.terms.jobId)}/services/operations/list`, {
    ...payload,
    authNonce: nonce,
    authExpiry: expiry,
    authSignature,
  }, input.fetchImpl ?? fetch);
  const page = deserialise<ReusableOperationPage>(raw);
  validateReusableOperationPage(page, job);
  return page;
}

/** Re-submit a listed logical operation so the gateway records B's reuse without another provider charge. */
export async function executeReusablePaidOperation(input: {
  apiUrl: string;
  escrowAddress: Hex;
  chainId: number;
  job: JobSnapshot;
  operation: GatewayOperation;
  account: WorkerAccount;
  fetchImpl?: typeof fetch;
}): Promise<GatewayOperation> {
  const { job, account, operation } = input;
  const worker = account.address.toLowerCase() as typeof account.address;
  if (job.task.assignedWorker?.toLowerCase() !== worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
  assertReusableOperation(operation, job);
  const request = {
    operationId: operation.operationId,
    jobId: job.terms.jobId,
    taskId: job.task.taskId,
    worker,
    epoch: job.task.epoch,
    service: operation.service,
    inputDigest: operation.inputDigest,
    amount: operation.amount.toString(),
    asset: operation.asset,
  };
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const nonce = randomHex32();
  const authSignature = await account.signTypedData({
    domain: gatewayActionDomain(input.chainId, input.escrowAddress),
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message: gatewayActionMessage({
      action: "SERVICE_EXECUTE",
      job,
      actor: worker,
      epoch: job.task.epoch,
      payload: { ...request, amount: operation.amount.toString() },
      nonce,
      expiry,
    }),
  });
  const raw = await postJsonResult(input.apiUrl, `/api/jobs/${encodeURIComponent(job.terms.jobId)}/services/execute`, {
    ...request,
    authNonce: nonce,
    authExpiry: expiry,
    authSignature,
  }, input.fetchImpl ?? fetch);
  const reused = deserialise<GatewayOperation>(raw);
  if (reused.operationId !== operation.operationId || reused.state !== "OUTPUT_AVAILABLE"
    || reused.worker.toLowerCase() !== operation.worker.toLowerCase() || reused.epoch !== operation.epoch
    || reused.outputDigest?.toLowerCase() !== operation.outputDigest?.toLowerCase()
    || reused.outputRef !== operation.outputRef
    || !reused.reusedBy?.some((entry) => entry.worker.toLowerCase() === worker.toLowerCase()
      && entry.epoch === job.task.epoch)) {
    throw new Error("REUSABLE_OPERATION_RESULT_MISMATCH");
  }
  return reused;
}

/** Retrieve the already-paid bytes through the buyer gateway after B's signed reuse authorization. */
export async function retrieveReusablePaidOutput(input: {
  apiUrl: string;
  escrowAddress: Hex;
  chainId: number;
  job: JobSnapshot;
  operation: GatewayOperation;
  account: WorkerAccount;
  fetchImpl?: typeof fetch;
}): Promise<Uint8Array> {
  const { job, account, operation } = input;
  const worker = account.address.toLowerCase() as typeof account.address;
  if (job.task.assignedWorker?.toLowerCase() !== worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
  assertReusableOperation(operation, job);
  if (!operation.outputRef || !operation.outputDigest) throw new Error("PAID_OUTPUT_NOT_AVAILABLE");
  const payload = {
    operationId: operation.operationId,
    requestFingerprint: operation.requestFingerprint,
    worker,
    epoch: job.task.epoch,
  };
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const nonce = randomHex32();
  const authSignature = await account.signTypedData({
    domain: gatewayActionDomain(input.chainId, input.escrowAddress),
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message: gatewayActionMessage({
      action: "SERVICE_OUTPUT_GET",
      job,
      actor: worker,
      epoch: job.task.epoch,
      payload,
      nonce,
      expiry,
    }),
  });
  const response = await postJsonResponse(input.apiUrl,
    `/api/jobs/${encodeURIComponent(job.terms.jobId)}/services/operations/${encodeURIComponent(operation.operationId)}/output`, {
      worker,
      epoch: job.task.epoch,
      authNonce: nonce,
      authExpiry: expiry,
      authSignature,
    }, input.fetchImpl ?? fetch, { accept: "application/octet-stream", timeoutMs: 60_000 });
  if (response.headers.get("x-baton-operation-id") !== operation.operationId
    || response.headers.get("x-baton-output-digest")?.toLowerCase() !== operation.outputDigest.toLowerCase()) {
    throw new Error("PAID_OUTPUT_RESPONSE_BINDING_MISMATCH");
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/octet-stream")) {
    throw new Error("PAID_OUTPUT_RESPONSE_TYPE_INVALID");
  }
  const bytes = await readBoundedOutput(response, MAX_ARTIFACT_BYTES);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error("PAID_OUTPUT_SIZE_LIMIT_EXCEEDED");
  const outputDigest = `0x${createHash("sha256").update(bytes).digest("hex")}`;
  if (outputDigest.toLowerCase() !== operation.outputDigest.toLowerCase()) throw new Error("PAID_OUTPUT_DIGEST_MISMATCH");
  return bytes;
}

/** Find, authorize, and retrieve one previously paid result into the worker process. */
export async function recoverReusablePaidOperation(input: {
  apiUrl: string;
  escrowAddress: Hex;
  chainId: number;
  job: JobSnapshot;
  operationId: string;
  account: WorkerAccount;
  fetchImpl?: typeof fetch;
}): Promise<{ operation: GatewayOperation; bytes: Uint8Array }> {
  let after: OperationPageCursor | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const page = await listReusablePaidOperations({ ...input, after });
    const operation = page.operations.find((entry) => entry.operationId === input.operationId);
    if (operation) {
      const reused = await executeReusablePaidOperation({ ...input, operation });
      const bytes = await retrieveReusablePaidOutput({ ...input, operation: reused });
      return { operation: reused, bytes };
    }
    if (!page.nextCursor) throw new Error("REUSABLE_OPERATION_NOT_FOUND");
    const cursorKey = `${page.nextCursor.createdAt}\u0000${page.nextCursor.operationId}`;
    if (seenCursors.has(cursorKey)) throw new Error("REUSABLE_OPERATION_CURSOR_LOOP");
    seenCursors.add(cursorKey);
    after = page.nextCursor;
  }
}

function validateReusableOperationPage(page: ReusableOperationPage, job: JobSnapshot): void {
  if (!page || !Array.isArray(page.operations)
    || (page.nextCursor !== null && (!page.nextCursor || typeof page.nextCursor.createdAt !== "string"
      || typeof page.nextCursor.operationId !== "string"))) throw new Error("REUSABLE_OPERATION_PAGE_INVALID");
  for (const operation of page.operations) assertReusableOperation(operation, job);
}

function assertReusableOperation(operation: GatewayOperation, job: JobSnapshot): void {
  const expectedFingerprint = paymentIntentFingerprint({
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
  const mismatches = [
    operation.jobId !== job.terms.jobId && "job",
    operation.taskId !== job.task.taskId && "task",
    operation.state !== "OUTPUT_AVAILABLE" && "state",
    operation.providerId !== job.servicePolicy.providerId && "provider",
    operation.network !== job.servicePolicy.network && "network",
    operation.payee.toLowerCase() !== job.servicePolicy.payee.toLowerCase() && "payee",
    operation.asset !== job.servicePolicy.asset && "asset",
    operation.policyVersion !== job.servicePolicy.policyVersion && "policyVersion",
    operation.approvedPolicyHash.toLowerCase() !== digest(job.servicePolicy).toLowerCase() && "policyHash",
    (operation.amount <= 0n || operation.amount > job.servicePolicy.perRequestCap) && "amount",
    operation.requestFingerprint.toLowerCase() !== expectedFingerprint.toLowerCase() && "fingerprint",
  ].filter((mismatch): mismatch is string => typeof mismatch === "string");
  if (mismatches.length) throw new Error(`REUSABLE_OPERATION_BINDING_MISMATCH:${mismatches.join(",")}`);
}

async function postJson(apiUrl: string, path: string, body: unknown, fetchImpl: typeof fetch): Promise<void> {
  await postJsonResponse(apiUrl, path, body, fetchImpl);
}

async function postJsonResult(apiUrl: string, path: string, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await postJsonResponse(apiUrl, path, body, fetchImpl);
  try {
    return await response.json();
  } catch {
    throw new Error("GATEWAY_API_RESPONSE_INVALID");
  }
}

async function postJsonResponse(
  apiUrl: string,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
  options: { accept?: string; timeoutMs?: number } = {},
): Promise<Response> {
  let endpoint: URL;
  try {
    endpoint = new URL(path, apiUrl);
  } catch {
    throw new Error("GATEWAY_API_URL_INVALID");
  }
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname))) {
    throw new Error("GATEWAY_API_TLS_REQUIRED");
  }
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { accept: options.accept ?? "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    throw new Error("GATEWAY_API_UNAVAILABLE");
  }
  if (response.ok) return response;
  let code = "GATEWAY_API_REJECTED";
  try {
    const result = await response.json() as { error?: unknown };
    if (typeof result.error === "string" && /^[A-Z0-9_:-]+$/.test(result.error)) code = result.error;
  } catch {
    // Keep a stable error when the API does not return JSON.
  }
  throw new Error(code);
}

function randomHex32(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}

async function readBoundedOutput(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(maximumBytes)) {
    throw new Error("PAID_OUTPUT_SIZE_LIMIT_EXCEEDED");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("PAID_OUTPUT_SIZE_LIMIT_EXCEEDED");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
