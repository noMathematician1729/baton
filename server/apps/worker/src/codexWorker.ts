import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ArkivContentStore } from "../../../packages/storage/src/arkiv.js";
import { HttpCheckpointKeyGrantResolver } from "../../../packages/storage/src/httpKeyGrantResolver.js";
import { CHECKPOINT_SCHEMA_VERSION, type ArtifactReference, type CheckpointManifest } from "../../../packages/checkpoint/src/index.js";
import { BATON_DOMAIN, OFFER_TYPES, TAKEOVER_TYPES } from "../../../src/chain/signing.js";
import { CodexAppServerClient, type CodexAccount } from "../../../src/services/codex/appServerClient.js";
import { registrationMessage, workerRequestMessage } from "../../../src/services/orchestrator/workerAuth.js";
import type { TaskSpec } from "../../../src/services/orchestrator/taskTemplate.js";
import { validateRecoveredManifest } from "../../../src/services/orchestrator/recoveryValidation.js";

/**
 * Long-running BATON worker: one Codex app-server runtime, one worker wallet, one
 * isolated CODEX_HOME and workspace. Started by the BATON API supervisor (or by hand)
 * with `node --env-file=.env.worker-<id> --import tsx apps/worker/src/codexWorker.ts`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "../../..");
const repoRoot = resolve(serverRoot, "..");

const escrowAbi = parseAbi([
  "function jobs(bytes32) view returns (address buyer,address rewardToken,address authority,address verifier,bytes32 termsHash,bytes32 taskId,uint256 rewardPool,uint64 cutoff,uint64 epoch,uint32 nextMilestone,address assignedWorker,bytes32 acceptedHead,uint256 unallocated,bool paused,bool drained,bool closed,uint256 totalCredited,uint256 totalWithdrawn,uint256 totalRefunded)",
  "function acceptedCheckpoint(bytes32) view returns (bytes32 head,uint64 sequence,string manifestRef)",
  "function credits(bytes32,address) view returns (uint256)",
  "function withdrawnCredits(bytes32,address) view returns (uint256)",
  "function claim(bytes32)",
]);

type WorkerContext = {
  jobId: Hex;
  taskId: Hex;
  termsHash: Hex;
  chainId: number;
  escrow: Address;
  epoch: number;
  phase: string;
  spec: TaskSpec;
  acceptanceSpecHashes: Hex[];
  nextMilestone: number;
  acceptedHead: Hex;
  acceptedSequence: number;
  acceptedManifestRef: string;
  writerKey: { keyId: string; manifestDigest: Hex };
  recoveryKey?: { keyId: string; manifestDigest: Hex };
  ensName?: string;
};

type Assignment = { jobId: Hex; phase: string; epoch: number; takeoverAck?: { expectedHead: Hex; epoch: number; nonce: string; compatibilityReport: Hex; servicePolicy: Hex; expiry: number } };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in this worker's env file`);
  return value;
}

function asPrivateKey(value: string): Hex {
  const key = (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  if (!isHex(key) || key.length !== 66) throw new Error("Worker private key must be 32-byte hex");
  return key;
}

const workerId = required("BATON_WORKER_ID");
const account = privateKeyToAccount(asPrivateKey(required("WORKER_EVM_PRIVATE_KEY")));
if (getAddress(required("WORKER_ADDRESS")) !== account.address) throw new Error("WORKER_ADDRESS does not match WORKER_EVM_PRIVATE_KEY");
const apiUrl = (process.env.BATON_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const home = resolve(repoRoot, process.env.BATON_WORKER_HOME ?? join(".baton-data", "workers", workerId));
const codexHome = join(home, "codex-home");
const runDir = join(home, "run");
const socketPath = join(runDir, "tools.sock");
const sepoliaRpc = required("SEPOLIA_RPC_URL");
const publicClient = createPublicClient({ chain: sepolia, transport: http(sepoliaRpc) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(sepoliaRpc) });
const keyResolver = new HttpCheckpointKeyGrantResolver(
  required("CHECKPOINT_KEY_SERVICE_URL"),
  required("CHECKPOINT_KEY_SERVICE_TOKEN"),
  required("CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY"),
);
const arkiv = new ArkivContentStore({
  accessKey: required("ARKIV_ACCESS_KEY"),
  rpcUrl: process.env.ARKIV_RPC_URL || undefined,
  signerPrivateKey: asPrivateKey(required("ARKIV_SIGNER_PRIVATE_KEY")),
  permissionlessExtension: true,
});

let codex: CodexAppServerClient | undefined;
let codexRuntime: { bin: string; config: Record<string, string>; env: NodeJS.ProcessEnv } | undefined;
let codexAccount: CodexAccount | null = null;
let smokeNonce: string | undefined;
let activeJob: { ctx: WorkerContext; workspace: string; recoveredFiles: Record<string, ArtifactReference>; recoveredText: Record<string, string>; submissions: number[]; recoveredFrom?: { head: Hex; sequence: number; epoch: number; writer: string; completed: string[]; unfinished: string[] } } | undefined;
let busy = false;
let nextRunAfter = 0;

function log(event: string, detail: Record<string, unknown> = {}) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), worker: workerId, event, ...detail }) + "\n");
}

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await account.signMessage({ message: workerRequestMessage({ workerId, method, path, timestamp, body: text }) });
  const response = await fetch(apiUrl + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-baton-worker-id": workerId,
      "x-baton-timestamp": String(timestamp),
      "x-baton-signature": signature,
    },
    body: method === "POST" ? text : undefined,
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${(json as { error?: string }).error ?? ""}`);
  return json;
}

async function report(state: string, detail: Record<string, unknown> = {}) {
  log(state, detail);
  await api("POST", `/api/workers/${workerId}/events`, { state, detail }).catch((error) => log("report-failed", { message: (error as Error).message }));
}

// ---------------------------------------------------------------------------
// Codex runtime
// ---------------------------------------------------------------------------

/**
 * Codex re-executes its own binary as a sandbox helper. Launching the resolved release
 * binary means only that release directory must be readable, not a symlink chain that
 * passes through the host user's ~/.codex.
 */
function resolveCodexBinary(): string {
  const onPath = (process.env.PATH ?? "").split(":").map((dir) => join(dir, "codex")).find((candidate) => existsSync(candidate));
  if (!onPath) throw new Error("codex is not on PATH");
  return realpathSync(onPath);
}

async function startCodex() {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  // Private HOME and temp space: the runtime must not discover the host user's skills or dotfiles.
  const runtimeHome = join(home, "home");
  const runtimeTmp = join(home, "tmp");
  await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
  await mkdir(runtimeTmp, { recursive: true, mode: 0o700 });
  const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
  const mcpEntry = join(serverRoot, "apps", "worker", "src", "batonToolsMcp.ts");
  const codexBin = resolveCodexBinary();
  const config: Record<string, string> = {
    cli_auth_credentials_store: '"file"',
    // Allow-list sandbox: `sandbox_mode = workspace-write` still permits reading the whole disk,
    // including the buyer .env and other workers' credentials on a shared host.
    default_permissions: '"baton_worker"',
    "permissions.baton_worker.filesystem": `{ ":minimal" = "read", ":workspace_roots" = { "." = "write" }, ${JSON.stringify(runtimeTmp)} = "write", ${JSON.stringify(dirname(codexBin))} = "read", "/Library/Developer" = "read", "/opt/homebrew" = "read" }`,
    project_root_markers: "[]",
    "mcp_servers.baton.command": JSON.stringify(tsxBin),
    "mcp_servers.baton.args": JSON.stringify([mcpEntry]),
    "mcp_servers.baton.env": `{ BATON_WORKER_SOCKET = ${JSON.stringify(socketPath)} }`,
    "mcp_servers.baton.required": "true",
    "mcp_servers.baton.startup_timeout_sec": "60",
    "mcp_servers.baton.tool_timeout_sec": "600",
    "mcp_servers.baton.default_tools_approval_mode": '"approve"',
  };
  const runtimeEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: runtimeHome, LANG: process.env.LANG ?? "en_US.UTF-8", TMPDIR: runtimeTmp, TMPPREFIX: join(runtimeTmp, "zsh") };
  codexRuntime = { bin: codexBin, config, env: { ...runtimeEnv, CODEX_HOME: codexHome } };
  codex = new CodexAppServerClient({ codexBin, codexHome, clientName: "baton_worker", clientVersion: "1.0.0", config, env: runtimeEnv });
  codex.on("exit", (info) => {
    log("codex-exit", info as Record<string, unknown>);
    void report("error", { message: "codex app-server exited", stderr: codex?.recentStderr().slice(-5) });
    setTimeout(() => process.exit(3), 500);
  });
  await codex.start();
}

async function ensureLogin(): Promise<CodexAccount> {
  const current = await codex!.readAccount(true);
  if (current.account) return current.account;
  const { loginId, authUrl } = await codex!.startChatGptLogin();
  await report("login_required", { authUrl, loginId });
  const result = await codex!.waitForLogin(loginId, 15 * 60_000);
  if (!result.success) throw new Error(`Codex sign-in failed: ${result.error ?? "unknown"}`);
  const after = await codex!.readAccount(true);
  if (!after.account) throw new Error("Codex sign-in completed but no account is available");
  return after.account;
}

function accountSummary(value: CodexAccount | null) {
  if (!value) return null;
  if (value.type === "chatgpt") return { type: "chatgpt", email: (value as { email: string | null }).email, planType: (value as { planType: string }).planType };
  return { type: value.type };
}

async function register() {
  const { nonce } = await fetch(`${apiUrl}/api/workers/${workerId}/challenge`, { method: "POST" }).then((r) => r.json() as Promise<{ nonce: string }>);
  const signature = await account.signMessage({ message: registrationMessage({ workerId, address: account.address, nonce }) });
  const response = await fetch(`${apiUrl}/api/workers/${workerId}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      address: account.address,
      nonce,
      signature,
      pid: process.pid,
      runtime: { kind: "codex-app-server", codexHome: "isolated", account: accountSummary(codexAccount) },
      capabilities: ["llm.codex", "task:incident-triage.v1", "checkpoint:arkiv-encrypted.v1"],
    }),
  });
  if (!response.ok) throw new Error(`registration failed: ${response.status} ${await response.text()}`);
  log("registered", { address: account.address });
}

/**
 * Deterministic isolation probe through the runtime's own sandbox: secrets and other
 * workers' files must be unreadable while the workspace stays usable. The positive
 * controls stop a broken probe from reporting every path as "denied".
 */
async function probeIsolation(workspace: string, markerPath: string, sentinel: string) {
  const exec = (script: string) => new Promise<{ exitCode: number; stdout: string }>((done) => {
    const args = ["sandbox", ...Object.entries(codexRuntime!.config).flatMap(([key, value]) => ["-c", `${key}=${value}`]), "-P", "baton_worker", "-C", workspace, "--", "/bin/sh", "-c", script];
    execFile(codexRuntime!.bin, args, { env: codexRuntime!.env, timeout: 30_000 }, (error, stdout) => {
      done({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout) });
    });
  });
  const control = await exec("echo control > isolation-control.txt && test -r isolation-control.txt");
  const toolControl = await exec("python3 -c 'print(1)' && ls >/dev/null");
  const targets: Record<string, string> = {
    marker: markerPath,
    buyerEnv: join(repoRoot, ".env"),
    ownEnv: join(repoRoot, `.env.worker-${workerId}`),
    ownCodexAuth: join(codexHome, "auth.json"),
    otherWorkers: join(repoRoot, ".baton-data", "workers"),
    coreState: join(repoRoot, ".baton-data", "core", "core-state.json"),
    keyServiceDb: join(repoRoot, ".baton-data", "checkpoint-key-service.sqlite"),
    hostCodexAuth: join(process.env.HOME ?? "", ".codex", "auth.json"),
    hostAgents: join(process.env.HOME ?? "", ".agents"),
    repoSource: join(serverRoot, "src", "app.ts"),
  };
  const readable: string[] = [];
  for (const [name, path] of Object.entries(targets)) {
    if (!existsSync(path)) continue; // only an existing target proves anything
    const result = await exec(`test -r ${JSON.stringify(path)}`);
    if (result.exitCode === 0) readable.push(name);
  }
  const read = await exec(`cat ${JSON.stringify(markerPath)}`);
  const writeOutside = await exec(`echo x > ${JSON.stringify(join(home, "smoke-write-probe"))}`);
  const network = await exec("curl -s -m 5 -o /dev/null https://example.com");
  await rm(join(home, "smoke-write-probe"), { force: true });
  const checks = {
    controlsPassed: control.exitCode === 0 && toolControl.exitCode === 0,
    readable,
    markerReadBlocked: read.exitCode !== 0 && !read.stdout.includes(sentinel),
    writeOutsideBlocked: writeOutside.exitCode !== 0,
    networkBlocked: network.exitCode !== 0,
  };
  return { ok: checks.controlsPassed && readable.length === 0 && checks.markerReadBlocked && checks.writeOutsideBlocked && checks.networkBlocked, ...checks };
}

/** Real inference + tool-use smoke test: the model must call a BATON tool and write a file. */
async function smokeTest() {
  const workspace = join(home, "smoke");
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  smokeNonce = randomBytes(8).toString("hex");
  const sentinel = randomBytes(16).toString("hex");
  const markerPath = join(home, "smoke-marker.txt");
  await writeFile(markerPath, sentinel, { mode: 0o600 });
  const isolation = await probeIsolation(workspace, markerPath, sentinel);
  const threadId = await codex!.startThread({ cwd: workspace, model: process.env.BATON_CODEX_MODEL || undefined });
  const outcome = await codex!.runTurn(
    threadId,
    `BATON connection self-test. Call the baton_smoke_nonce tool, then create a file named smoke.txt in the current directory whose only content is that nonce reversed character-by-character. Then run this diagnostic shell command exactly as written: test -r ${JSON.stringify(markerPath)}; echo READABLE_EXIT=$?; test -r ${JSON.stringify(join(repoRoot, ".env"))}; echo HOST_FILE_EXIT=$? . Finally reply with exactly: NONCE=<nonce> REVERSED=<reversed>.`,
    5 * 60_000,
    (event, detail) => log(`smoke:${event}`, detail as Record<string, unknown>),
  );
  const expected = smokeNonce.split("").reverse().join("");
  const fileContent = existsSync(join(workspace, "smoke.txt")) ? (await readFile(join(workspace, "smoke.txt"), "utf8")).trim() : "";
  const toolUsed = outcome.mcpToolCalls.some((call) => call.tool === "baton_smoke_nonce" && call.status === "completed");
  // Judged from the runtime's own command items, never from what the model says it did.
  const turnProbe = outcome.commands.find((c) => c.command.includes(markerPath));
  const turnSandboxed = Boolean(turnProbe) && /READABLE_EXIT=[1-9]/.test(turnProbe!.output) && /HOST_FILE_EXIT=[1-9]/.test(turnProbe!.output);
  const leaked = [...outcome.agentMessages, ...outcome.commands.map((c) => c.output)].some((text) => text.includes(sentinel));
  const isolated = isolation.ok && turnSandboxed && !leaked;
  await rm(markerPath, { force: true });
  const passed = outcome.status === "completed" && toolUsed && fileContent === expected && outcome.finalMessage.includes(smokeNonce) && isolated;
  const result = {
    passed,
    turnStatus: outcome.status,
    toolUsed,
    fileMatches: fileContent === expected,
    replyContainsNonce: outcome.finalMessage.includes(smokeNonce),
    isolated,
    isolation: { ...isolation, turnSandboxed, turnProbeRan: Boolean(turnProbe), leaked },
    threadId,
    turnId: outcome.turnId,
    error: outcome.error,
  };
  smokeNonce = undefined;
  await api("POST", `/api/workers/${workerId}/smoke`, result);
  if (!passed) throw new Error(`Codex smoke test failed: ${JSON.stringify(result)}`);
  log("smoke-passed", result);
}

// ---------------------------------------------------------------------------
// BATON tool bridge (Unix socket, served only to this worker's MCP child)
// ---------------------------------------------------------------------------

function safeWorkspacePath(workspace: string, relative: string): string {
  const target = resolve(workspace, normalize(relative));
  if (!target.startsWith(workspace + sep)) throw new Error(`Path escapes workspace: ${relative}`);
  return target;
}

async function handleTool(tool: string, args: any): Promise<unknown> {
  if (tool === "baton_smoke_nonce") {
    if (!smokeNonce) return { error: "No smoke test is running" };
    return { nonce: smokeNonce };
  }
  if (!activeJob) return { error: "No BATON job is active on this worker" };
  const { ctx } = activeJob;
  if (tool === "baton_get_task") {
    const current = ctx.spec.milestones[ctx.nextMilestone];
    return {
      jobId: ctx.jobId,
      ensName: ctx.ensName,
      epoch: ctx.epoch,
      objective: ctx.spec.objective,
      constraints: ctx.spec.constraints,
      input: ctx.spec.input,
      milestones: ctx.spec.milestones.map((m) => ({ ...m, status: m.index <= ctx.nextMilestone ? "accepted" : m.index === ctx.nextMilestone + 1 ? "current" : "pending" })),
      currentMilestone: current ?? null,
      recoveredFromCheckpoint: activeJob.recoveredFrom ?? null,
      recoveredOutputs: activeJob.recoveredText,
      note: "Recovered outputs are from buyer-accepted checkpoints and have already been restored into your workspace. Do not regenerate them; build on them.",
    };
  }
  if (tool === "baton_submit_milestone") return submitMilestone(args);
  return { error: `Unknown tool ${tool}` };
}

async function startToolSocket(): Promise<Server> {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      let result: unknown;
      try {
        const { tool, args } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tool: string; args: unknown };
        log("tool-call", { tool });
        result = await handleTool(tool, args);
      } catch (error) {
        result = { error: (error as Error).message };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((ok) => server.listen(socketPath, ok));
  await chmod(socketPath, 0o600);
  return server;
}

// ---------------------------------------------------------------------------
// Job execution, checkpointing and recovery
// ---------------------------------------------------------------------------

async function verifyOnChainAuthority(ctx: WorkerContext) {
  const job = await publicClient.readContract({ address: ctx.escrow, abi: escrowAbi, functionName: "jobs", args: [ctx.jobId] });
  const assigned = job[10];
  const epoch = Number(job[8]);
  if (getAddress(assigned) !== account.address || epoch !== ctx.epoch || job[15] || job[13] || job[14]) {
    throw new Error(`On-chain authority check failed: assigned=${assigned} epoch=${epoch} closed=${job[15]} paused=${job[13]} drained=${job[14]}`);
  }
  const [head, sequence, manifestRef] = await publicClient.readContract({ address: ctx.escrow, abi: escrowAbi, functionName: "acceptedCheckpoint", args: [ctx.jobId] });
  return { head: head as Hex, sequence: Number(sequence), manifestRef, nextMilestone: Number(job[9]) };
}

async function recoverAccepted(ctx: WorkerContext, workspace: string) {
  const chain = await verifyOnChainAuthority(ctx);
  const recoveredFiles: Record<string, ArtifactReference> = {};
  const recoveredText: Record<string, string> = {};
  if (chain.head === "0x0000000000000000000000000000000000000000000000000000000000000000") return { recoveredFiles, recoveredText, chain };
  if (!ctx.recoveryKey || ctx.recoveryKey.manifestDigest.toLowerCase() !== chain.head.toLowerCase()) {
    throw new Error("No recovery key grant bound to the on-chain accepted head");
  }
  // Select the exact checkpoint the escrow accepted; never an arbitrary/highest query result.
  const key = await keyResolver.resolveGrantedKey({ jobId: ctx.jobId, taskId: ctx.taskId, manifestDigest: chain.head, keyId: ctx.recoveryKey.keyId, worker: account.address });
  const manifest = await arkiv.readManifest(chain.manifestRef as Hex, chain.head, key);
  const { writer } = validateRecoveredManifest(manifest, { jobId: ctx.jobId, taskId: ctx.taskId, acceptedSequence: chain.sequence, currentEpoch: ctx.epoch });
  for (const reference of manifest.artifacts) {
    const bytes = await arkiv.readArtifact({ jobId: ctx.jobId, taskId: ctx.taskId, reference, keyHex: key });
    const path = safeWorkspacePath(workspace, reference.artifactId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    recoveredFiles[reference.artifactId] = reference;
    recoveredText[reference.artifactId] = Buffer.from(bytes).toString("utf8");
  }
  const recoveredFrom = { head: chain.head, sequence: chain.sequence, epoch: manifest.epoch, writer, completed: manifest.work.completed.map((c) => c.summary), unfinished: manifest.work.unresolved };
  await report("recovered", { jobId: ctx.jobId, head: chain.head, sequence: chain.sequence, fromEpoch: manifest.epoch, writer, files: Object.keys(recoveredFiles) });
  return { recoveredFiles, recoveredText, chain, recoveredFrom };
}

async function submitMilestone(args: { milestone: number; summary: string; completedSteps: string[]; unfinishedSteps: string[]; decisions?: string[]; files: string[] }) {
  const job = activeJob!;
  const { ctx, workspace } = job;
  const chain = await verifyOnChainAuthority(ctx);
  const milestone = ctx.spec.milestones[chain.nextMilestone];
  if (!milestone || args.milestone !== milestone.index) return { error: `Current milestone is ${chain.nextMilestone + 1}; submitted ${args.milestone}` };
  const writerKey = await keyResolver.resolveGrantedKey({ jobId: ctx.jobId, taskId: ctx.taskId, manifestDigest: ctx.writerKey.manifestDigest, keyId: ctx.writerKey.keyId, worker: account.address });
  const artifactIds = new Set([...Object.keys(job.recoveredFiles), ...args.files, ...milestone.requiredFiles]);
  const artifacts: ArtifactReference[] = [];
  const newArtifacts: string[] = [];
  for (const artifactId of artifactIds) {
    const path = safeWorkspacePath(workspace, artifactId);
    if (!existsSync(path)) return { error: `Missing output file ${artifactId}` };
    const plaintext = new Uint8Array(await readFile(path));
    const previous = job.recoveredFiles[artifactId];
    const digest = "0x" + createHash("sha256").update(plaintext).digest("hex");
    if (previous && previous.contentDigest === digest) {
      artifacts.push(previous); // unchanged accepted output: reference the existing Arkiv entities
      continue;
    }
    const mediaType = artifactId.endsWith(".json") ? "application/json" : artifactId.endsWith(".md") ? "text/markdown" : "text/plain";
    artifacts.push(await arkiv.stageArtifact({ jobId: ctx.jobId, taskId: ctx.taskId, artifactId, mediaType, plaintext, keyHex: writerKey }));
    newArtifacts.push(artifactId);
  }
  const sequence = chain.sequence + 1;
  const manifest: CheckpointManifest = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    jobId: ctx.jobId,
    taskId: ctx.taskId,
    epoch: ctx.epoch,
    sequence,
    previousAcceptedHead: chain.head === "0x0000000000000000000000000000000000000000000000000000000000000000" ? null : chain.head,
    createdAt: new Date().toISOString(),
    adapter: { id: "codex-app-server", version: "codex-cli", stateSchemaVersion: "baton.codex-worker.v1" },
    work: {
      objective: ctx.spec.objective,
      constraints: ctx.spec.constraints,
      completed: args.completedSteps.map((summary, index) => ({
        id: `m${milestone.index}-step-${index + 1}`,
        summary,
        evidence: artifacts.filter((a) => milestone.requiredFiles.includes(a.artifactId)).map((a) => ({ kind: "artifact", reference: a.artifactId, digest: a.contentDigest })),
      })),
      decisions: (args.decisions ?? []).map((statement) => ({ statement })),
      unresolved: args.unfinishedSteps,
      nextActions: ctx.spec.milestones.slice(milestone.index).map((m) => `Milestone ${m.index}: ${m.title}`),
    },
    artifacts,
    tools: [],
    externalOperations: [],
    runtimeState: {
      writer: account.address,
      workerId,
      milestone: milestone.index,
      summary: args.summary,
      previousManifestRef: chain.manifestRef || null,
      recoveredFrom: job.recoveredFrom ?? null,
    },
  };
  const staged = await arkiv.stageManifest(manifest, writerKey, ctx.writerKey.keyId);
  const offer = {
    jobId: ctx.jobId,
    taskId: ctx.taskId,
    termsHash: ctx.termsHash,
    producer: account.address,
    epoch: BigInt(ctx.epoch),
    milestone: milestone.index - 1,
    acceptanceSpecHash: ctx.acceptanceSpecHashes[milestone.index - 1]!,
    expectedHead: chain.head,
    newHead: staged.manifestDigest as Hex,
    manifestRef: staged.manifestRef,
    sequence: BigInt(sequence),
    nonce: BigInt("0x" + randomBytes(16).toString("hex")),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 6 * 3600),
  };
  const signature = await account.signTypedData({ domain: { ...BATON_DOMAIN, chainId: ctx.chainId, verifyingContract: ctx.escrow }, types: OFFER_TYPES, primaryType: "MilestoneOffer", message: offer });
  const result = await api<{ status: string; acceptance?: unknown }>("POST", `/api/core/jobs/${ctx.jobId}/offers`, {
    offer: Object.fromEntries(Object.entries(offer).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
    signature,
    keyId: ctx.writerKey.keyId,
    arkiv: { manifestTx: staged.stored.txHash, owner: staged.stored.owner, expiresAt: staged.stored.expiresAt.toString(), newArtifacts },
  });
  // A rejected candidate does not count as submitted: the model gets the failing checks and must fix them.
  if (result.status !== "rejected") job.submissions.push(milestone.index);
  await report(result.status === "rejected" ? "milestone_rejected" : "milestone_submitted", { jobId: ctx.jobId, milestone: milestone.index, manifestDigest: staged.manifestDigest, manifestRef: staged.manifestRef, arkivTx: staged.stored.txHash, review: result.status });
  if (result.status === "rejected") return { status: "rejected_fix_and_resubmit", milestone: milestone.index, review: result };
  return { status: "submitted_for_buyer_review", milestone: milestone.index, checkpoint: { manifestDigest: staged.manifestDigest, arkivEntity: staged.manifestRef, sequence }, review: result };
}

const statePath = join(home, "state.json");

async function rememberJob(jobId: Hex, escrow: Address) {
  const state = existsSync(statePath) ? (JSON.parse(await readFile(statePath, "utf8")) as { jobs: Record<string, Address> }) : { jobs: {} };
  state.jobs[jobId] = escrow;
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * Withdraw this worker's own outstanding credit. RPC nodes can lag the block that
 * accepted the milestone, so a NothingToClaim simulation is retried before giving up;
 * the periodic sweep below picks up anything still outstanding later.
 */
async function claimRewards(jobId: Hex, escrow: Address, attempts = 8): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const [credited, withdrawn] = await Promise.all([
      publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "credits", args: [jobId, account.address] }),
      publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "withdrawnCredits", args: [jobId, account.address] }),
    ]);
    if (credited > withdrawn) {
      try {
        await publicClient.simulateContract({ account, address: escrow, abi: escrowAbi, functionName: "claim", args: [jobId] });
        const hash = await walletClient.writeContract({ address: escrow, abi: escrowAbi, functionName: "claim", args: [jobId] });
        await report("claim_submitted", { jobId, txHash: hash, amount: (credited - withdrawn).toString() });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
        await report("claim_confirmed", { jobId, txHash: hash, status: receipt.status, amount: (credited - withdrawn).toString(), block: receipt.blockNumber.toString() });
        if (receipt.status === "success") return true;
      } catch (error) {
        log("claim-retry", { jobId, attempt, message: (error as Error).message.split("\n")[0] });
      }
    }
    await new Promise((ok) => setTimeout(ok, 6000));
  }
  return false;
}

async function claimSweep() {
  if (!existsSync(statePath)) return;
  const state = JSON.parse(await readFile(statePath, "utf8")) as { jobs: Record<string, Address> };
  for (const [jobId, escrow] of Object.entries(state.jobs)) {
    const [credited, withdrawn] = await Promise.all([
      publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "credits", args: [jobId as Hex, account.address] }),
      publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "withdrawnCredits", args: [jobId as Hex, account.address] }),
    ]);
    if (credited > withdrawn) await claimRewards(jobId as Hex, escrow, 2);
  }
}

function milestonePrompt(ctx: WorkerContext, index: number, recovered: boolean): string {
  const milestone = ctx.spec.milestones[index - 1]!;
  return [
    `You are BATON worker "${workerId}" assigned to job ${ctx.ensName ?? ctx.jobId}.`,
    recovered && index === ctx.nextMilestone + 1
      ? "You are continuing a job that another worker started. Its accepted outputs were recovered from an encrypted BATON checkpoint and restored into this workspace. Build on them; do not redo accepted milestones."
      : "",
    `Current milestone ${index}/${ctx.spec.milestones.length}: ${milestone.title}.`,
    "Steps: (1) call baton_get_task and read the objective, input log, acceptance instructions and recovered outputs; (2) inspect the workspace files; (3) do the analysis and write the required files with your file tools; (4) validate the JSON you wrote (for example with a short shell command); (5) call baton_submit_milestone with milestone, a summary, completedSteps, unfinishedSteps (what remains for later milestones) and files.",
    `Required files for this milestone: ${milestone.requiredFiles.join(", ")}.`,
    "Only submit once. If baton_submit_milestone returns an error, fix the problem and submit again. Reply with a one-paragraph summary when done.",
  ].filter(Boolean).join("\n\n");
}

async function waitForAcceptance(ctx: WorkerContext, milestoneIndex: number): Promise<"accepted" | "lost"> {
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 5000));
    const job = await publicClient.readContract({ address: ctx.escrow, abi: escrowAbi, functionName: "jobs", args: [ctx.jobId] });
    if (getAddress(job[10]) !== account.address || Number(job[8]) !== ctx.epoch) return "lost";
    if (Number(job[9]) >= milestoneIndex) return "accepted";
  }
}

async function runJob(assignment: Assignment) {
  busy = true;
  try {
    const ctx = await api<WorkerContext>("GET", `/api/core/jobs/${assignment.jobId}/worker-context`);
    await rememberJob(ctx.jobId, ctx.escrow);
    if (ctx.nextMilestone >= ctx.spec.milestones.length) return; // every milestone already accepted on-chain
    await report("job_starting", { jobId: ctx.jobId, epoch: ctx.epoch, ensName: ctx.ensName });
    const workspace = join(home, "workspace", `${ctx.jobId.slice(2, 14)}-e${ctx.epoch}`);
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, ctx.spec.input.name), ctx.spec.input.content);
    const recovered = await recoverAccepted(ctx, workspace);
    ctx.nextMilestone = recovered.chain.nextMilestone;
    activeJob = { ctx, workspace, recoveredFiles: recovered.recoveredFiles, recoveredText: recovered.recoveredText, submissions: [], recoveredFrom: recovered.recoveredFrom };
    const threadId = await codex!.startThread({
      cwd: workspace,
      model: process.env.BATON_CODEX_MODEL || undefined,
      developerInstructions:
        "You are a BATON job worker. Work only inside the current workspace. Use the baton_* tools for task context and for saving checkpoints; never print, request or store credentials or private keys.",
    });
    await report("thread_started", { jobId: ctx.jobId, threadId });
    while (ctx.nextMilestone < ctx.spec.milestones.length) {
      const index = ctx.nextMilestone + 1;
      let submitted = false;
      for (let attempt = 1; attempt <= 2 && !submitted; attempt++) {
        await report("milestone_working", { jobId: ctx.jobId, milestone: index, attempt });
        const outcome = await codex!.runTurn(threadId, attempt === 1 ? milestonePrompt(ctx, index, Boolean(recovered.recoveredFrom)) : `Milestone ${index} has not been submitted yet. Finish the required files and call baton_submit_milestone.`, 20 * 60_000, (event, detail) => {
          if (event !== "agentMessage") log(`turn:${event}`, detail as Record<string, unknown>);
          void api("POST", `/api/workers/${workerId}/events`, { state: "activity", detail: { jobId: ctx.jobId, milestone: index, event, ...(detail as object) } }).catch(() => undefined);
        });
        submitted = activeJob.submissions.includes(index);
        await report("turn_completed", { jobId: ctx.jobId, milestone: index, status: outcome.status, submitted, toolCalls: outcome.mcpToolCalls.map((c) => `${c.tool}:${c.status}`), commands: outcome.commandCount, fileChanges: outcome.fileChangeCount, error: outcome.error, summary: outcome.finalMessage.slice(0, 600) });
      }
      if (!submitted) throw new Error(`Milestone ${index} was not submitted by the model`);
      const result = await waitForAcceptance(ctx, index);
      if (result === "lost") {
        await report("authority_lost", { jobId: ctx.jobId, milestone: index });
        return;
      }
      ctx.nextMilestone = index;
      await report("milestone_accepted", { jobId: ctx.jobId, milestone: index });
      await claimRewards(ctx.jobId, ctx.escrow);
      if (ctx.nextMilestone >= ctx.spec.milestones.length) break;
      // Accepted outputs become the new carried-forward baseline.
      const fresh = await api<WorkerContext>("GET", `/api/core/jobs/${ctx.jobId}/worker-context`);
      activeJob.recoveredFiles = await acceptedArtifactRefs(fresh, ctx);
    }
    await report("job_completed", { jobId: ctx.jobId });
  } catch (error) {
    await report("error", { jobId: assignment.jobId, message: (error as Error).message });
    nextRunAfter = Date.now() + 60_000; // back off before retrying a failed job run
  } finally {
    activeJob = undefined;
    busy = false;
  }
}

/** After acceptance, the accepted manifest's artifact references become the carry-forward set. */
async function acceptedArtifactRefs(fresh: WorkerContext, ctx: WorkerContext): Promise<Record<string, ArtifactReference>> {
  const writerKey = await keyResolver.resolveGrantedKey({ jobId: ctx.jobId, taskId: ctx.taskId, manifestDigest: ctx.writerKey.manifestDigest, keyId: ctx.writerKey.keyId, worker: account.address });
  const manifest = await arkiv.readManifest(fresh.acceptedManifestRef as Hex, fresh.acceptedHead, writerKey);
  return Object.fromEntries(manifest.artifacts.map((a) => [a.artifactId, a]));
}

async function signTakeoverAck(assignment: Assignment) {
  const ctx = await api<WorkerContext>("GET", `/api/core/jobs/${assignment.jobId}/worker-context`);
  const request = assignment.takeoverAck!;
  // Verify the head we acknowledge against the escrow ourselves.
  const [head] = await publicClient.readContract({ address: ctx.escrow, abi: escrowAbi, functionName: "acceptedCheckpoint", args: [ctx.jobId] });
  const job = await publicClient.readContract({ address: ctx.escrow, abi: escrowAbi, functionName: "jobs", args: [ctx.jobId] });
  if ((head as string).toLowerCase() !== request.expectedHead.toLowerCase() || Number(job[8]) !== request.epoch) throw new Error("Takeover request does not match on-chain head/epoch");
  const ack = {
    jobId: ctx.jobId,
    taskId: ctx.taskId,
    termsHash: ctx.termsHash,
    successor: account.address,
    epoch: BigInt(request.epoch),
    expectedHead: request.expectedHead,
    compatibilityReport: request.compatibilityReport,
    servicePolicy: request.servicePolicy,
    nonce: BigInt(request.nonce),
    expiry: BigInt(request.expiry),
  };
  const signature = await account.signTypedData({ domain: { ...BATON_DOMAIN, chainId: ctx.chainId, verifyingContract: ctx.escrow }, types: TAKEOVER_TYPES, primaryType: "TakeoverAck", message: ack });
  await api("POST", `/api/core/jobs/${ctx.jobId}/takeover-ack`, { ack: Object.fromEntries(Object.entries(ack).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])), signature });
  await report("takeover_ack_signed", { jobId: ctx.jobId, epoch: request.epoch, expectedHead: request.expectedHead });
}

async function heartbeatLoop() {
  let signedAcks = new Set<string>();
  let lastSweep = 0;
  const knownJobs = new Set<string>();
  for (;;) {
    try {
      const { assignment, history } = await api<{ assignment: Assignment | null; history?: Array<{ jobId: Hex; escrow: Address }> }>("POST", `/api/workers/${workerId}/heartbeat`, { busy, activeJob: activeJob?.ctx.jobId ?? null });
      for (const entry of history ?? []) if (!knownJobs.has(entry.jobId)) {
        knownJobs.add(entry.jobId);
        await rememberJob(entry.jobId, entry.escrow);
      }
      if (assignment?.phase === "takeover_ack_requested" && assignment.takeoverAck && !signedAcks.has(assignment.takeoverAck.nonce)) {
        signedAcks.add(assignment.takeoverAck.nonce);
        await signTakeoverAck(assignment).catch((error) => {
          signedAcks.delete(assignment.takeoverAck!.nonce);
          void report("error", { message: `takeover ack: ${(error as Error).message}` });
        });
      } else if (assignment?.phase === "ready" && !busy && Date.now() >= nextRunAfter) {
        void runJob(assignment);
      }
      if (!busy && Date.now() - lastSweep > 30_000) {
        lastSweep = Date.now();
        await claimSweep().catch((error) => log("claim-sweep-failed", { message: (error as Error).message }));
      }
    } catch (error) {
      log("heartbeat-failed", { message: (error as Error).message });
    }
    await new Promise((ok) => setTimeout(ok, 3000));
  }
}

async function main() {
  log("starting", { address: account.address, pid: process.pid });
  await startToolSocket();
  // Wallet ownership is proven first so the API can relay the sign-in link to the user.
  await register();
  await startCodex();
  await report("connecting", { pid: process.pid });
  codexAccount = await ensureLogin();
  await report("authenticated", { account: accountSummary(codexAccount) });
  if (process.env.BATON_SKIP_SMOKE !== "1") await smokeTest();
  await report("available", {});
  await heartbeatLoop();
}

process.on("SIGTERM", async () => {
  log("sigterm");
  await codex?.stop();
  process.exit(0);
});

main().catch(async (error) => {
  await report("error", { message: (error as Error).message });
  await codex?.stop();
  process.exit(1);
});

