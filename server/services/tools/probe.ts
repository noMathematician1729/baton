import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolProbeResult } from "./schema.js";
import { createSyntheticToolServer, TOOL_SCHEMA_VERSION } from "./mcp.js";
import { digestFixture, processBatch, syntheticBatches } from "./fixtures.js";

export async function probeSyntheticTool(batchId: "batch-1" | "batch-2" | "batch-3"): Promise<ToolProbeResult> {
  const startedAt = performance.now();
  const server = createSyntheticToolServer();
  const client = new Client({ name: "baton-admission-probe", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const discovered = await client.listTools();
    const tool = discovered.tools.find((item) => item.name === "process_batch");
    const schemaVersion = (tool?._meta as { batonSchemaVersion?: string } | undefined)?.batonSchemaVersion ?? "unknown";
    if (!tool) {
      return {
        serverId: "baton-synthetic-data",
        toolName: "process_batch",
        schemaVersion: "unknown",
        passed: false,
        latencyMs: performance.now() - startedAt,
        inputDigest: digestFixture(syntheticBatches[batchId]),
        errorCode: "SCHEMA_MISMATCH",
      };
    }
    const result = await client.callTool({
      name: tool.name,
      arguments: { batchId },
    });
    const expected = processBatch(batchId);
    const output = result.structuredContent as { outputDigest?: unknown; count?: unknown; sum?: unknown } | undefined;
    const passed = !result.isError &&
      output?.outputDigest === expected.outputDigest &&
      output.count === expected.count &&
      output.sum === expected.sum;
    return {
      serverId: "baton-synthetic-data",
      toolName: tool.name,
      schemaVersion,
      passed: passed && schemaVersion === TOOL_SCHEMA_VERSION,
      latencyMs: performance.now() - startedAt,
      inputDigest: digestFixture(syntheticBatches[batchId]),
      outputDigest: typeof output?.outputDigest === "string" ? output.outputDigest : undefined,
      errorCode: passed && schemaVersion === TOOL_SCHEMA_VERSION ? undefined : "TOOL_ERROR",
    };
  } catch {
    return {
      serverId: "baton-synthetic-data",
      toolName: "process_batch",
      schemaVersion: TOOL_SCHEMA_VERSION,
      passed: false,
      latencyMs: performance.now() - startedAt,
      inputDigest: processBatch(batchId).outputDigest,
      errorCode: "TOOL_ERROR",
    };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}
