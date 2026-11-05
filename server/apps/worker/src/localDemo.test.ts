import assert from "node:assert/strict";
import { test } from "node:test";
import { runLocalDemo } from "./localDemo.js";

test("local worker A-to-B checkpoint handoff recovers all batches", () => {
  const result = runLocalDemo();
  assert.deepEqual(result.finalState.completed.map(({ batchId }) => batchId), ["batch-1", "batch-2", "batch-3"]);
  assert.equal(result.posteriorMean, 0.6);
  assert.ok(result.encryptedEnvelopeBytes > 0);
});
