import { request } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * Narrow BATON tool surface exposed to a Codex worker thread over MCP stdio.
 * It holds no keys or tokens: every call is forwarded to the owning worker
 * daemon through a Unix socket inside that worker's private 0700 runtime directory.
 */
const socketPath = process.env.BATON_WORKER_SOCKET;
if (!socketPath) throw new Error("BATON_WORKER_SOCKET is required");

function callDaemon(tool: string, args: unknown): Promise<unknown> {
  const body = JSON.stringify({ tool, args });
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: "/tool", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(600_000, () => req.destroy(new Error("BATON worker daemon timed out")));
    req.end(body);
  });
}

async function forward(tool: string, args: unknown) {
  try {
    const result = await callDaemon(tool, args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: `BATON tool unavailable: ${(error as Error).message}` }] };
  }
}

const server = new McpServer({ name: "baton-worker-tools", version: "1.0.0" });

server.registerTool(
  "baton_get_task",
  {
    description:
      "Return the BATON job assigned to this worker: objective, the current milestone and its acceptance rules, input data, and outputs recovered from accepted checkpoints. Call this before doing any job work.",
    inputSchema: {},
  },
  async () => forward("baton_get_task", {}),
);

server.registerTool(
  "baton_submit_milestone",
  {
    description:
      "Save an encrypted recovery checkpoint to Arkiv and submit the current milestone for buyer review. List every output file (relative to the workspace) that this milestone produced or updated, the steps completed so far, and the steps still unfinished so another worker could continue.",
    inputSchema: {
      milestone: z.number().int().min(1).describe("1-based milestone number being submitted"),
      summary: z.string().min(1).max(4000),
      completedSteps: z.array(z.string().min(1)).min(1).max(40),
      unfinishedSteps: z.array(z.string()).max(40),
      decisions: z.array(z.string()).max(40).optional(),
      files: z.array(z.string().min(1)).min(1).max(16).describe("workspace-relative output paths"),
    },
  },
  async (args) => forward("baton_submit_milestone", args),
);

server.registerTool(
  "baton_smoke_nonce",
  {
    description: "Connection self-test only: returns a one-time nonce from the BATON worker daemon.",
    inputSchema: {},
  },
  async () => forward("baton_smoke_nonce", {}),
);

await server.connect(new StdioServerTransport());
