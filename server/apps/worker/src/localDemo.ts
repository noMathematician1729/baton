import assert from "node:assert/strict";
import { decryptManifest, encryptManifest, type CheckpointManifest } from "../../../packages/checkpoint/src/index.js";
import {
  addObservation,
  createBetaBernoulliState,
  createBatchState,
  importBatchState,
  posteriorMean,
  runNextBatch,
  verifyBatchState,
} from "../../../packages/runtime/src/index.js";

const LOCAL_ONLY_KEY = "0x" + "11".repeat(32);

export function runLocalDemo() {
  const jobId = "local-handoff-demo";
  const taskId = "three-batch-task";
  const stateA = runNextBatch(createBatchState(jobId, taskId), "batch-1");
  const quantitativeA = addObservation(createBetaBernoulliState(), "observation-1", true);
  const manifest: CheckpointManifest = {
    schemaVersion: 1,
    jobId,
    taskId,
    epoch: 1,
    sequence: 1,
    previousAcceptedHead: null,
    createdAt: new Date().toISOString(),
    adapter: {
      id: stateA.adapterId,
      version: stateA.adapterVersion,
      stateSchemaVersion: stateA.stateSchemaVersion,
    },
    work: {
      objective: "Process three deterministic synthetic batches and continue after worker replacement.",
      constraints: ["Use only local fixture data.", "Do not make network calls."],
      completed: [{ id: "batch-1", summary: "Worker A processed batch 1.", evidence: [] }],
      decisions: [{ statement: "Sort input rows by ID before aggregation." }],
      unresolved: [],
      nextActions: ["Worker B processes batches 2 and 3."],
    },
    artifacts: [],
    tools: [],
    externalOperations: [],
    runtimeState: stateA,
    quantitativeState: quantitativeA,
  };

  const envelope = encryptManifest(manifest, LOCAL_ONLY_KEY, "local-only-demo");
  const recovered = decryptManifest(JSON.parse(JSON.stringify(envelope)), LOCAL_ONLY_KEY);
  assert.deepEqual(recovered.runtimeState, stateA);

  const stateB = importBatchState(recovered.runtimeState, jobId, taskId);
  const quantitativeB = recovered.quantitativeState as typeof quantitativeA;
  const finalState = runNextBatch(runNextBatch(stateB, "batch-2"), "batch-3");
  const finalQuantitative = addObservation(
    addObservation(quantitativeB, "observation-2", false),
    "observation-3",
    true,
  );
  const uninterruptedQuantitative = [true, false, true].reduce(
    (state, outcome, index) => addObservation(state, "observation-" + (index + 1), outcome),
    createBetaBernoulliState(),
  );

  assert.equal(verifyBatchState(finalState), true);
  assert.deepEqual(finalQuantitative, uninterruptedQuantitative);
  assert.equal(posteriorMean(finalQuantitative), 0.6);

  return {
    stateA,
    finalState,
    posteriorMean: posteriorMean(finalQuantitative),
    encryptedEnvelopeBytes: Buffer.byteLength(JSON.stringify(envelope)),
  };
}
