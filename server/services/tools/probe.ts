import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolProbeResult } from "./schema.js";
import { createSyntheticToolServer, TOOL_SCHEMA_VERSION } from "./mcp.js";
import { digest } from "../../src/protocol/v1.js";
import { digestFixture, processBatch, syntheticBatches } from "./fixtures.js";

export type McpToolProbeConfig = {
  serverUrl: string;
  bearerToken: string;
  expectedServerId: string;
  toolName: string;
  schemaVersion: string;
  schemaDigest: string;
  input: Record<string, unknown>;
  expectedOutputDigest: string;
  timeoutMs?: number;
};

export async function discoverConfiguredMcpTools(input: {
  serverUrl: string;
  bearerToken: string;
  timeoutMs?: number;
}): Promise<{ serverId: string; version: string; tools: Array<Record<string, unknown>> }> {
  assertMcpConnectionConfig(input);
  const client = new Client({ name: "baton-worker-capability-probe", version: "1.0.0" });
  try {
    await client.connect(createHttpProbeTransport(input));
    const server = client.getServerVersion();
    const { tools } = await client.listTools();
    return {
      serverId: server?.name ?? "unknown",
      version: server?.version ?? "unknown",
      tools: tools.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
        schemaDigest: digest({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null }),
        schemaVersion: (tool._meta as { batonSchemaVersion?: string } | undefined)?.batonSchemaVersion ?? "unknown",
        annotations: tool.annotations ?? {},
      })),
    };
  } finally {
    await Promise.allSettled([client.close()]);
  }
}

export async function probeConfiguredMcpTool(config: McpToolProbeConfig): Promise<ToolProbeResult> {
  assertMcpProbeConfig(config);
  const startedAt = performance.now();
  const client = new Client({ name: "baton-worker-capability-probe", version: "1.0.0" });
  try {
    await client.connect(createHttpProbeTransport(config));
    return await probeMcpToolWithClient(client, config);
  } catch (error) {
    return failedResult(config, digest(config.input), error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "TOOL_ERROR", startedAt);
  } finally {
    await Promise.allSettled([client.close()]);
  }
}

/** Probe a connected client; the discovered tool must explicitly declare safe read-only behavior. */
export async function probeMcpToolWithClient(
  client: Pick<Client, "listTools" | "callTool" | "getServerVersion">,
  config: Pick<McpToolProbeConfig,
    "expectedServerId" | "toolName" | "schemaVersion" | "schemaDigest" | "input" | "expectedOutputDigest">,
): Promise<ToolProbeResult> {
  const startedAt = performance.now();
  const inputDigest = digest(config.input);
  try {
    const [server, discovered] = [client.getServerVersion(), await client.listTools()];
    const tool = discovered.tools.find((candidate) => candidate.name === config.toolName);
    const schemaVersion = (tool?._meta as { batonSchemaVersion?: string } | undefined)?.batonSchemaVersion ?? "unknown";
    const schemaDigest = tool?.outputSchema
      ? digest({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema })
      : undefined;
    if (server?.name !== config.expectedServerId || !tool || !tool.outputSchema
      || schemaVersion !== config.schemaVersion
      || schemaDigest !== config.schemaDigest) {
      return {
        serverId: server?.name ?? "unknown",
        toolName: config.toolName,
        schemaVersion,
        passed: false,
        latencyMs: performance.now() - startedAt,
        ...(schemaDigest ? { schemaDigest } : {}),
        inputDigest,
        errorCode: "SCHEMA_MISMATCH",
      };
    }
    if (tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint === true) {
      return {
        serverId: server.name,
        toolName: tool.name,
        schemaVersion,
        passed: false,
        latencyMs: performance.now() - startedAt,
        schemaDigest,
        inputDigest,
        errorCode: "TOOL_ERROR",
      };
    }

    const result = await client.callTool({ name: tool.name, arguments: config.input });
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    const outputDigest = structured
      ? (typeof structured.outputDigest === "string" && /^0x[\da-f]{64}$/i.test(structured.outputDigest)
        ? structured.outputDigest
        : digest(structured))
      : undefined;
    const passed = !result.isError && outputDigest?.toLowerCase() === config.expectedOutputDigest.toLowerCase();
    return {
      serverId: server.name,
      toolName: tool.name,
      schemaVersion,
      passed,
      latencyMs: performance.now() - startedAt,
      schemaDigest,
      inputDigest,
      ...(outputDigest ? { outputDigest } : {}),
      ...(!passed ? { errorCode: "TOOL_ERROR" as const } : {}),
    };
  } catch (error) {
    return failedResult(config, inputDigest, error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : "TOOL_ERROR");
  }
}

export async function probeSyntheticTool(batchId: "batch-1" | "batch-2" | "batch-3"): Promise<ToolProbeResult> {
  const server = createSyntheticToolServer();
  const client = new Client({ name: "baton-admission-probe", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const discovered = await client.listTools();
    const tool = discovered.tools.find((item) => item.name === "process_batch");
    const output = processBatch(batchId);
    if (!tool) return failedResult({ toolName: "process_batch" }, digestFixture(syntheticBatches[batchId]), "SCHEMA_MISMATCH");
    return await probeMcpToolWithClient(client, {
      expectedServerId: "baton-synthetic-data",
      toolName: "process_batch",
      schemaVersion: TOOL_SCHEMA_VERSION,
      schemaDigest: digest({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }),
      input: { batchId },
      expectedOutputDigest: output.outputDigest,
    });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function assertMcpProbeConfig(config: McpToolProbeConfig): void {
  assertMcpConnectionConfig(config);
  if (!config.expectedServerId.trim() || !config.toolName.trim() || !config.schemaVersion.trim()) {
    throw new Error("MCP_PROBE_EXPECTATION_REQUIRED");
  }
  if (!/^0x[\da-f]{64}$/i.test(config.schemaDigest) || !/^0x[\da-f]{64}$/i.test(config.expectedOutputDigest)) {
    throw new Error("MCP_PROBE_DIGEST_INVALID");
  }
}

function assertMcpConnectionConfig(config: { serverUrl: string; bearerToken: string; timeoutMs?: number }): void {
  if (!config.bearerToken.trim()) throw new Error("MCP_PROBE_TOKEN_REQUIRED");
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1)) {
    throw new Error("MCP_PROBE_TIMEOUT_INVALID");
  }
  let url: URL;
  try {
    url = new URL(config.serverUrl);
  } catch {
    throw new Error("MCP_PROBE_URL_INVALID");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("MCP_PROBE_TLS_REQUIRED");
  if (url.username || url.password || url.hash) throw new Error("MCP_PROBE_URL_INVALID");
}

function createHttpProbeTransport(config: { serverUrl: string; bearerToken: string; timeoutMs?: number }) {
  return new StreamableHTTPClientTransport(new URL(config.serverUrl), {
    requestInit: { headers: { authorization: `Bearer ${config.bearerToken}` } },
    redirectPolicy: "same-origin",
    fetch: (input, init) => fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    }),
  });
}

function failedResult(
  config: Partial<Pick<McpToolProbeConfig, "expectedServerId" | "toolName" | "schemaVersion" | "input">>,
  inputDigest: string,
  errorCode: "SCHEMA_MISMATCH" | "TIMEOUT" | "TOOL_ERROR",
  startedAt = performance.now(),
): ToolProbeResult {
  return {
    serverId: config.expectedServerId ?? "unknown",
    toolName: config.toolName ?? "unknown",
    schemaVersion: config.schemaVersion ?? "unknown",
    passed: false,
    latencyMs: performance.now() - startedAt,
    inputDigest,
    errorCode,
  };
}
