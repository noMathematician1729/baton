import { getAddress } from "viem";
import type { CheckpointKeyGrantRequest } from "../../../packages/storage/src/recovery.js";
import { authorizeSignedGatewayAction, type GatewayActionNonceStore } from "../../chain/gatewayActionAuth.js";
import type { Hex, JobSnapshot } from "../../protocol/v1.js";

export interface CheckpointGrantWriter {
  grantKey(request: CheckpointKeyGrantRequest, keyHex: string): void;
}

/** Require a buyer-signed grant for the exact checkpoint already accepted in the local chain mirror. */
export async function grantAcceptedCheckpointKey(input: {
  job: JobSnapshot;
  request: CheckpointKeyGrantRequest;
  keyHex: string;
  keyId: string;
  authorizationBody: unknown;
  chainId: number;
  verifyingContract: string;
  nonceStore: GatewayActionNonceStore;
  writer: CheckpointGrantWriter;
  nowSeconds?: number;
}): Promise<void> {
  const { job, request } = input;
  const worker = getAddress(request.worker);
  if (request.jobId !== job.terms.jobId || request.taskId !== job.terms.task.taskId
    || job.task.taskId !== job.terms.task.taskId) throw new Error("KEY_GRANT_JOB_BINDING_MISMATCH");
  if (!Number.isSafeInteger(job.task.acceptedHead.sequence) || job.task.acceptedHead.sequence < 1
    || !job.task.acceptedHead.manifestRef
    || request.manifestDigest.toLowerCase() !== job.task.acceptedHead.manifestDigest.toLowerCase()) {
    throw new Error("KEY_GRANT_CHECKPOINT_NOT_ACCEPTED");
  }
  if (!input.keyId || request.keyId !== input.keyId) throw new Error("KEY_GRANT_ID_MISMATCH");
  const payload = {
    jobId: job.terms.jobId,
    taskId: job.terms.task.taskId,
    manifestDigest: request.manifestDigest.toLowerCase(),
    keyId: request.keyId,
    worker: worker.toLowerCase(),
  };
  await authorizeSignedGatewayAction({
    chainId: input.chainId,
    verifyingContract: input.verifyingContract,
    nonceStore: input.nonceStore,
    body: input.authorizationBody,
    job,
    actor: job.terms.buyer,
    epoch: job.task.epoch,
    action: "GRANT_CHECKPOINT_KEY",
    payload,
    nowSeconds: input.nowSeconds,
  });
  input.writer.grantKey({
    ...request,
    worker,
    manifestDigest: request.manifestDigest.toLowerCase() as Hex,
  }, input.keyHex);
}
