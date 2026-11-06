import { isHex, type Address, type Hex } from "viem";
import type { privateKeyToAccount } from "viem/accounts";
import type { CheckpointKeyGrantResolver, RecoveredAcceptedPackage } from "../../../packages/storage/src/recovery.js";
import { recoverAcceptedPackage } from "../../../packages/storage/src/recovery.js";
import { importCheckpointRuntimeState, type ImportedCheckpointRuntimeState } from "../../../packages/runtime/src/index.js";
import type { ConfirmedTakeoverState, SepoliaAuthorityReader } from "../../../src/chain/sepoliaAuthority.js";
import { deserialise, type Hex as ProtocolHex, type JobSnapshot } from "../../../src/protocol/v1.js";
import { submitRecoveredCheckpointAcknowledgement } from "./takeoverPolicyClient.js";

type WorkerAccount = ReturnType<typeof privateKeyToAccount>;
type AcceptedPackageStore = Parameters<typeof recoverAcceptedPackage>[0]["store"];
type RecoveryAuthority = Pick<
  SepoliaAuthorityReader,
  "readTakeoverState" | "assertSnapshotCurrent" | "assertPreapprovedSuccessor"
>;

export async function fetchJobSnapshotFromGateway(input: {
  apiUrl: string;
  jobId: string;
  fetchImpl?: typeof fetch;
}): Promise<JobSnapshot> {
  if (!input.jobId.trim()) throw new Error("JOB_ID_REQUIRED");
  const endpoint = apiEndpoint(input.apiUrl, `/api/jobs/${encodeURIComponent(input.jobId)}`);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(endpoint, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("GATEWAY_API_UNAVAILABLE");
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error("JOB_NOT_FOUND");
    throw new Error("GATEWAY_JOB_READ_FAILED");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("GATEWAY_JOB_RESPONSE_INVALID");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !("job" in payload)) throw new Error("GATEWAY_JOB_RESPONSE_INVALID");
  const job = deserialise<JobSnapshot>((payload as { job: unknown }).job);
  if (!job || typeof job !== "object" || job.terms?.jobId !== input.jobId) {
    throw new Error("GATEWAY_JOB_BINDING_MISMATCH");
  }
  return job;
}

/** Recover the chain-confirmed checkpoint, import its runtime state, then acknowledge that exact head. */
export async function recoverAndAcknowledgeAcceptedCheckpoint(input: {
  apiUrl: string;
  chainId: number;
  escrowAddress: Hex;
  job: JobSnapshot;
  account: WorkerAccount;
  authority: RecoveryAuthority;
  store: AcceptedPackageStore;
  keyGrants: CheckpointKeyGrantResolver;
  expectedStorageOwner: Address;
  fetchImpl?: typeof fetch;
}): Promise<{
  recovered: RecoveredAcceptedPackage;
  importedState: ImportedCheckpointRuntimeState;
  acceptedHead: Hex;
}> {
  const { job, account, authority } = input;
  if (!job.chainJobId || !job.chainTaskId) throw new Error("CHAIN_JOB_BINDING_REQUIRED");
  if (job.task.status !== "DRAINED" || !job.task.drained) throw new Error("TASK_NOT_DRAINED");
  if (!job.task.assignedWorker || job.task.assignedWorker.toLowerCase() === account.address.toLowerCase()) {
    throw new Error("SUCCESSOR_SIGNER_INVALID");
  }
  if (job.task.acceptedHead.sequence < 1) throw new Error("ACCEPTED_CHECKPOINT_REQUIRED");

  // Read the current chain head independently of the API snapshot, then fail closed unless both agree.
  const confirmed = await authority.readTakeoverState(job, account.address as Hex);
  assertConfirmedRecoveryState(job, account.address, confirmed);
  await authority.assertSnapshotCurrent(job);
  await authority.assertPreapprovedSuccessor(job, account.address as Hex);

  const recovered = await recoverAcceptedPackage({
    store: input.store,
    keyGrants: input.keyGrants,
    accepted: {
      jobId: job.terms.jobId,
      taskId: job.terms.task.taskId,
      producerEpoch: job.task.epoch,
      manifestDigest: confirmed.acceptedHead,
      manifestRef: confirmed.acceptedManifestRef as Hex,
      sequence: confirmed.acceptedSequence,
      previousAcceptedHead: job.task.acceptedHead.previousAcceptedHead,
      artifactManifestDigest: job.task.acceptedHead.artifactManifestDigest,
    },
    worker: account.address,
    expectedStorageOwner: input.expectedStorageOwner,
    supportedAdapters: [
      { id: "baton.deterministic-batch", version: "1.0.0", stateSchemaVersion: "1" },
      { id: "baton.beta-bernoulli", version: "1.0.0", stateSchemaVersion: "1" },
    ],
  });
  const importedState = importCheckpointRuntimeState(recovered.manifest, job.terms.jobId, job.task.taskId);

  await submitRecoveredCheckpointAcknowledgement({
    apiUrl: input.apiUrl,
    escrowAddress: input.escrowAddress,
    chainId: input.chainId,
    job,
    recovered,
    account,
    fetchImpl: input.fetchImpl,
  });
  return { recovered, importedState, acceptedHead: confirmed.acceptedHead };
}

function assertConfirmedRecoveryState(
  job: JobSnapshot,
  successor: Address,
  state: ConfirmedTakeoverState,
): void {
  const expected = job.task.acceptedHead;
  if (state.assignedWorker.toLowerCase() !== job.task.assignedWorker?.toLowerCase()
    || state.epoch !== job.task.epoch) throw new Error("ONCHAIN_ASSIGNMENT_CHANGED");
  if (!isBytes32(state.acceptedHead) || state.acceptedHead.toLowerCase() !== expected.manifestDigest.toLowerCase()) {
    throw new Error("CONFIRMED_ACCEPTED_HEAD_MISMATCH");
  }
  if (!isBytes32(state.acceptedManifestRef) || state.acceptedManifestRef.toLowerCase() !== expected.manifestRef.toLowerCase()) {
    throw new Error("CONFIRMED_ACCEPTED_LOCATOR_MISMATCH");
  }
  if (state.acceptedSequence !== expected.sequence) throw new Error("CONFIRMED_ACCEPTED_SEQUENCE_MISMATCH");
  if (!state.drained || state.paused || state.closed || state.expired) throw new Error("ONCHAIN_TASK_NOT_DRAINED");
  if (!state.successorGranted) throw new Error("SUCCESSOR_AUTHORITY_NOT_GRANTED");
  if (state.assignedWorker.toLowerCase() === successor.toLowerCase()) throw new Error("SUCCESSOR_SIGNER_INVALID");
}

function apiEndpoint(apiUrl: string, path: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(path, apiUrl);
  } catch {
    throw new Error("GATEWAY_API_URL_INVALID");
  }
  const localHttp = endpoint.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !localHttp) throw new Error("GATEWAY_API_TLS_REQUIRED");
  if (endpoint.username || endpoint.password || endpoint.hash) throw new Error("GATEWAY_API_URL_INVALID");
  return endpoint;
}

function isBytes32(value: unknown): value is ProtocolHex {
  return typeof value === "string" && isHex(value, { strict: true }) && value.length === 66;
}
