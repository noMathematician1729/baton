import type { CheckpointManifest } from "./schema.js";

export const batchOneCheckpoint: CheckpointManifest = {
  schemaVersion: 1,
  jobId: "demo-job-001",
  taskId: "batch-1",
  epoch: 1,
  sequence: 1,
  previousAcceptedHead: null,
  createdAt: "2026-11-05T16:00:00.000Z",
  adapter: { id: "baton.deterministic-batch", version: "1.0.0", stateSchemaVersion: "1" },
  work: {
    objective: "Process the first synthetic batch and preserve enough state for a replacement worker.",
    constraints: ["Use only the fixture input.", "Keep output deterministic."],
    completed: [{ id: "batch-1-output", summary: "Batch 1 was normalized and summarized.", evidence: [] }],
    decisions: [{ statement: "Sort rows by stable row ID before aggregation.", rationale: "Makes output repeatable across workers." }],
    unresolved: [],
    nextActions: ["Process batch 2 after takeover."],
  },
  artifacts: [],
  tools: [],
  externalOperations: [],
};
