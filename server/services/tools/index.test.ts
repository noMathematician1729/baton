import assert from "node:assert/strict";
import { test } from "node:test";
import { processBatch } from "./fixtures.js";
import { probeMcpToolWithClient, probeSyntheticTool } from "./probe.js";
import { digest } from "../../src/protocol/v1.js";

test("MCP discovery and tool invocation conform to the expected fixture", async () => {
  const result = await probeSyntheticTool("batch-1");
  assert.equal(result.passed, true);
  assert.equal(result.outputDigest, processBatch("batch-1").outputDigest);
});

test("MCP probe rejects a tool or input/output schema that differs from the expected contract", async () => {
  const serverId = "service";
  const tool = {
    name: "read_report",
    inputSchema: { type: "object", properties: { reportId: { type: "string" } }, required: ["reportId"] },
    outputSchema: { type: "object", properties: { outputDigest: { type: "string" } }, required: ["outputDigest"] },
    _meta: { batonSchemaVersion: "3" },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
  let calls = 0;
  const client = {
    getServerVersion: () => ({ name: serverId, version: "1.2.0" }),
    async listTools() { return { tools: [tool] }; },
    async callTool() { calls += 1; return { structuredContent: { outputDigest: digest("report") }, isError: false }; },
  } as unknown as Parameters<typeof probeMcpToolWithClient>[0];
  const result = await probeMcpToolWithClient(client, {
    expectedServerId: serverId,
    toolName: tool.name,
    schemaVersion: "wrong-version",
    schemaDigest: digest({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }),
    input: { reportId: "fresh-probe" },
    expectedOutputDigest: digest("report"),
  });
  assert.equal(result.errorCode, "SCHEMA_MISMATCH");
  assert.equal(calls, 0);
});

test("MCP probe does not invoke tools that lack a read-only annotation", async () => {
  const tool = {
    name: "mutate_report",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    _meta: { batonSchemaVersion: "1" },
    annotations: { readOnlyHint: false, destructiveHint: false },
  };
  let calls = 0;
  const client = {
    getServerVersion: () => ({ name: "service", version: "1" }),
    async listTools() { return { tools: [tool] }; },
    async callTool() { calls += 1; return { structuredContent: {}, isError: false }; },
  } as unknown as Parameters<typeof probeMcpToolWithClient>[0];
  const result = await probeMcpToolWithClient(client, {
    expectedServerId: "service",
    toolName: tool.name,
    schemaVersion: "1",
    schemaDigest: digest({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }),
    input: {},
    expectedOutputDigest: digest({}),
  });
  assert.equal(result.passed, false);
  assert.equal(result.errorCode, "TOOL_ERROR");
  assert.equal(calls, 0);
});
