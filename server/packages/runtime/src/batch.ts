import { z } from "zod";
import { processBatch, type BatchId } from "../../../services/tools/fixtures.js";

const batchIds = ["batch-1", "batch-2", "batch-3"] as const;

const BatchOutputSchema = z.object({
  batchId: z.enum(batchIds),
  count: z.number().int().positive(),
  sum: z.number(),
  outputDigest: z.string().regex(/^0x[\da-f]{64}$/i),
});

export const DeterministicBatchStateSchema = z.object({
  adapterId: z.literal("baton.deterministic-batch"),
  adapterVersion: z.literal("1.0.0"),
  stateSchemaVersion: z.literal("1"),
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  completed: z.array(BatchOutputSchema),
});

export type DeterministicBatchState = z.infer<typeof DeterministicBatchStateSchema>;

export function createBatchState(jobId: string, taskId: string): DeterministicBatchState {
  return DeterministicBatchStateSchema.parse({
    adapterId: "baton.deterministic-batch",
    adapterVersion: "1.0.0",
    stateSchemaVersion: "1",
    jobId,
    taskId,
    completed: [],
  });
}

export function importBatchState(state: unknown, expectedJobId: string, expectedTaskId: string): DeterministicBatchState {
  const parsed = DeterministicBatchStateSchema.parse(state);
  if (parsed.jobId !== expectedJobId || parsed.taskId !== expectedTaskId) {
    throw new Error("Checkpoint belongs to another job or task");
  }
  const completedIds = parsed.completed.map(({ batchId }) => batchId);
  if (new Set(completedIds).size !== completedIds.length) throw new Error("Checkpoint repeats a completed batch");
  for (const output of parsed.completed) {
    const reference = processBatch(output.batchId);
    if (reference.outputDigest !== output.outputDigest || reference.sum !== output.sum || reference.count !== output.count) {
      throw new Error("Checkpoint output does not match the deterministic reference");
    }
  }
  return parsed;
}

export function runNextBatch(state: DeterministicBatchState, batchId: BatchId): DeterministicBatchState {
  const current = DeterministicBatchStateSchema.parse(state);
  if (current.completed.some((batch) => batch.batchId === batchId)) throw new Error("Batch already completed");
  const output = processBatch(batchId);
  return DeterministicBatchStateSchema.parse({
    ...current,
    completed: [...current.completed, {
      batchId: output.batchId,
      count: output.count,
      sum: output.sum,
      outputDigest: output.outputDigest,
    }],
  });
}

export function verifyBatchState(state: DeterministicBatchState): boolean {
  const parsed = DeterministicBatchStateSchema.parse(state);
  return parsed.completed.length === batchIds.length && batchIds.every((id) => parsed.completed.some((item) => item.batchId === id));
}
