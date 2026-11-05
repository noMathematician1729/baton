import assert from "node:assert/strict";
import { test } from "node:test";
import { processBatch } from "./fixtures.js";
import { probeSyntheticTool } from "./probe.js";

test("MCP discovery and tool invocation conform to the expected fixture", async () => {
  const result = await probeSyntheticTool("batch-1");
  assert.equal(result.passed, true);
  assert.equal(result.outputDigest, processBatch("batch-1").outputDigest);
});
