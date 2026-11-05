import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { processBatch } from "./fixtures.js";

export const TOOL_SCHEMA_VERSION = "1";

export function createSyntheticToolServer() {
  const server = new McpServer({ name: "baton-synthetic-data", version: "1.0.0" });

  server.registerTool(
    "process_batch",
    {
      title: "Process synthetic batch",
      description: "Sort and summarize one fixed BATON demo batch.",
      inputSchema: { batchId: z.enum(["batch-1", "batch-2", "batch-3"]) },
      outputSchema: {
        batchId: z.string(),
        count: z.number(),
        sum: z.number(),
        outputDigest: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { batonSchemaVersion: TOOL_SCHEMA_VERSION },
    },
    async ({ batchId }) => {
      const result = processBatch(batchId);
      const structuredContent = {
        batchId: result.batchId,
        count: result.count,
        sum: result.sum,
        outputDigest: result.outputDigest,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent,
      };
    },
  );

  return server;
}
