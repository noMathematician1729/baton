import assert from "node:assert/strict";
import { test } from "node:test";
import { addObservation, createBetaBernoulliState, posteriorMean } from "./betaBernoulli.js";
import { createBatchState, importBatchState, runNextBatch, verifyBatchState } from "./batch.js";

test("a replacement worker resumes the deterministic fixture with matching output", () => {
  const stateA = runNextBatch(createBatchState("job-1", "task-1"), "batch-1");
  const recoveredByB = importBatchState(JSON.parse(JSON.stringify(stateA)), "job-1", "task-1");
  const finalState = runNextBatch(runNextBatch(recoveredByB, "batch-2"), "batch-3");
  assert.equal(verifyBatchState(finalState), true);
  assert.equal(finalState.completed[0]?.sum, 28);
});

test("Beta-Bernoulli state can continue after import and rejects duplicate observations", () => {
  const partial = addObservation(createBetaBernoulliState(), "obs-1", true);
  const resumed = addObservation(JSON.parse(JSON.stringify(partial)), "obs-2", false);
  assert.equal(posteriorMean(resumed), 0.5);
  assert.throws(() => addObservation(resumed, "obs-1", true));
});
