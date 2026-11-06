import type { CheckpointManifest } from "../../../packages/checkpoint/src/index.js";

/**
 * Validate a decrypted checkpoint selected by the escrow's accepted head before a
 * successor uses it. A checkpoint written in an earlier authority epoch is valid
 * recovery input: takeover advancing the epoch must not invalidate it.
 */
export function validateRecoveredManifest(
  manifest: CheckpointManifest,
  expected: { jobId: string; taskId: string; acceptedSequence: number; currentEpoch: number },
): { writer: string } {
  if (manifest.jobId !== expected.jobId || manifest.taskId !== expected.taskId) throw new Error("RECOVERY_WRONG_JOB");
  if (manifest.sequence !== expected.acceptedSequence) throw new Error("RECOVERY_SEQUENCE_MISMATCH");
  if (!Number.isInteger(manifest.epoch) || manifest.epoch < 1 || manifest.epoch > expected.currentEpoch) throw new Error("RECOVERY_EPOCH_INVALID");
  const writer = String((manifest.runtimeState as Record<string, unknown> | undefined)?.writer ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(writer)) throw new Error("RECOVERY_WRITER_MISSING");
  return { writer };
}
