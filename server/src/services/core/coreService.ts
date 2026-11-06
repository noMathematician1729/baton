import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseUnits,
  recoverTypedDataAddress,
  toBytes,
  verifyMessage,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { ArkivContentStore } from "../../../packages/storage/src/arkiv.js";
import { BATON_DOMAIN, OFFER_TYPES, TAKEOVER_TYPES } from "../../chain/signing.js";
import { CheckpointKeyGrantStore } from "../key-service/store.js";
import { acceptanceSpecHash, buildIncidentTriageSpec, checkMilestone, INCIDENT_TRIAGE_TEMPLATE_ID, termsHash } from "../orchestrator/taskTemplate.js";
import { registrationMessage, verifyWorkerRequest } from "../orchestrator/workerAuth.js";
import { assertConfirmed, JournaledChain } from "./chainOps.js";
import { CoreStore, nowIso, type CheckpointRecord, type JobRecord, type WorkerRecord } from "./coreStore.js";
import { EnsProvisioner } from "./ensProvisioner.js";

export const escrowAbi = parseAbi([
  "function jobs(bytes32) view returns (address buyer,address rewardToken,address authority,address verifier,bytes32 termsHash,bytes32 taskId,uint256 rewardPool,uint64 cutoff,uint64 epoch,uint32 nextMilestone,address assignedWorker,bytes32 acceptedHead,uint256 unallocated,bool paused,bool drained,bool closed,uint256 totalCredited,uint256 totalWithdrawn,uint256 totalRefunded)",
  "function acceptedCheckpoint(bytes32) view returns (bytes32 head,uint64 sequence,string manifestRef)",
  "function accounting(bytes32) view returns (uint256 funded,uint256 unallocated,uint256 workerCreditsOutstanding,uint256 totalRefunded,uint256 totalWithdrawn)",
  "function credits(bytes32,address) view returns (uint256)",
  "function withdrawnCredits(bytes32,address) view returns (uint256)",
  "function PROTOCOL_VERSION() view returns (bytes32)",
  "function fundJob(bytes32 jobId,bytes32 termsHash,bytes32 taskId,address rewardToken,address authority,address verifier,uint64 cutoff,uint256[] rewards,bytes32[] acceptanceSpecHashes)",
  "function assignTask(bytes32 jobId,address worker)",
  "function drainTask(bytes32 jobId)",
  "function close(bytes32 jobId)",
  "struct MilestoneOffer { bytes32 jobId; bytes32 taskId; bytes32 termsHash; address producer; uint64 epoch; uint32 milestone; bytes32 acceptanceSpecHash; bytes32 expectedHead; bytes32 newHead; string manifestRef; uint64 sequence; uint256 nonce; uint64 expiry; }",
  "struct TakeoverAck { bytes32 jobId; bytes32 taskId; bytes32 termsHash; address successor; uint64 epoch; bytes32 expectedHead; bytes32 compatibilityReport; bytes32 servicePolicy; uint256 nonce; uint64 expiry; }",
  "function acceptMilestone(bytes32 jobId, MilestoneOffer offer, bytes signature)",
  "function takeover(bytes32 jobId, TakeoverAck ack, bytes signature)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
  "function decimals() view returns (uint8)",
]);
const EMPTY_HEAD = `0x${"0".repeat(64)}` as Hex;
const V2_MARKER = keccak256(toBytes("BATON_JOB_ESCROW_V2"));
const COMPATIBILITY_REPORT = keccak256(toBytes(`baton.compat.v1:codex-app-server:${INCIDENT_TRIAGE_TEMPLATE_ID}`));
const SERVICE_POLICY = keccak256(toBytes("baton.service-policy.v1:no-paid-services"));
const HEARTBEAT_STALE_MS = 30_000;

export type CoreConfig = {
  repoRoot: string;
  dataDir: string;
  rpcUrl: string;
  chainId: number;
  buyerPrivateKey: Hex;
  escrow: Address;
  rewardToken: Address;
  ensParent: string;
  contractsOut: string;
  keyEncryptionKey: string;
  keyServiceDbPath: string;
  keyServiceStorageKey: string;
  arkivAccessKey: string;
  arkivRpcUrl?: string;
  buyerApiToken: string;
  apiUrl: string;
  confirmations: number;
};

export class CoreError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function sha256Hex(value: string): Hex {
  return `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
}

export function writerBinding(jobId: Hex, epoch: number): Hex {
  return sha256Hex(`baton-writer-grant:v1:${jobId}:${epoch}`);
}

export class CoreService {
  public readonly store: CoreStore;
  public readonly chain: JournaledChain;
  public readonly ens: EnsProvisioner;
  private readonly keys: CheckpointKeyGrantStore;
  private readonly arkiv: ArkivContentStore;
  private readonly running = new Map<string, Promise<void>>();

  public constructor(public readonly config: CoreConfig) {
    this.store = new CoreStore(join(config.dataDir, "core-state.json"));
    this.chain = new JournaledChain(this.store, config.rpcUrl, config.buyerPrivateKey, config.confirmations);
    this.ens = new EnsProvisioner(this.chain, config.contractsOut, config.ensParent);
    this.keys = new CheckpointKeyGrantStore(config.keyServiceDbPath, config.keyServiceStorageKey);
    this.arkiv = new ArkivContentStore({ accessKey: config.arkivAccessKey, rpcUrl: config.arkivRpcUrl, permissionlessExtension: true });
  }

  public get buyer(): Address {
    return this.chain.account.address;
  }

  /** Restart path: reload persisted mappings and resume any non-terminal job state machine. */
  public async init(): Promise<void> {
    const jobs = await this.store.read((s) => Object.values(s.jobs));
    for (const job of jobs) if (!["completed", "failed"].includes(job.phase)) this.kick(job.jobId);
  }

  public checkBuyerToken(token: string | undefined): void {
    if (!this.config.buyerApiToken || !token || token.length !== this.config.buyerApiToken.length
      || !require_timingSafeEqual(token, this.config.buyerApiToken)) throw new CoreError(401, "BUYER_AUTH_REQUIRED");
  }

  // -------------------------------------------------------------------------
  // Worker registry
  // -------------------------------------------------------------------------

  public async challenge(workerId: string): Promise<{ nonce: string }> {
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(workerId)) throw new CoreError(400, "WORKER_ID_INVALID");
    const nonce = randomBytes(16).toString("hex");
    await this.store.mutate((s) => {
      s.challenges[workerId] = { nonce, at: nowIso() };
    });
    return { nonce };
  }

  public async register(workerId: string, body: { address: string; nonce: string; signature: Hex; pid?: number; runtime?: WorkerRecord["runtime"]; capabilities?: string[] }) {
    const challenge = await this.store.read((s) => s.challenges[workerId]);
    if (!challenge || challenge.nonce !== body.nonce || Date.now() - Date.parse(challenge.at) > 120_000) throw new CoreError(401, "CHALLENGE_INVALID");
    const address = getAddress(body.address);
    const ok = await verifyMessage({ address, message: registrationMessage({ workerId, address, nonce: body.nonce }), signature: body.signature }).catch(() => false);
    if (!ok) throw new CoreError(401, "WALLET_OWNERSHIP_UNVERIFIED");
    return this.store.mutate((s) => {
      delete s.challenges[workerId];
      const existing = s.workers[workerId];
      if (existing && existing.address !== address) throw new CoreError(409, "WORKER_ID_BOUND_TO_OTHER_WALLET");
      if (Object.values(s.workers).some((w) => w.workerId !== workerId && w.address === address)) throw new CoreError(409, "WALLET_BOUND_TO_OTHER_WORKER");
      const record: WorkerRecord = {
        ...(existing ?? { events: [] }),
        workerId,
        address,
        walletVerifiedAt: nowIso(),
        runtime: body.runtime ?? { kind: "codex-app-server" },
        capabilities: body.capabilities ?? [],
        pid: body.pid ?? existing?.pid,
        connection: "starting",
        lastHeartbeatAt: nowIso(),
      } as WorkerRecord;
      record.events = [...(existing?.events ?? []), { at: nowIso(), state: "registered", detail: { address, pid: body.pid } }].slice(-400);
      s.workers[workerId] = record;
      return { workerId, address };
    });
  }

  public async authenticateWorker(headers: Record<string, string | string[] | undefined>, method: string, path: string, body: string): Promise<WorkerRecord> {
    const workerId = String(headers["x-baton-worker-id"] ?? "");
    const worker = await this.store.read((s) => s.workers[workerId]);
    if (!worker) throw new CoreError(401, "WORKER_UNKNOWN");
    const ok = await verifyWorkerRequest({
      workerId,
      expectedAddress: worker.address,
      method,
      path,
      timestamp: Number(headers["x-baton-timestamp"]),
      body,
      signature: String(headers["x-baton-signature"] ?? "") as Hex,
    });
    if (!ok) throw new CoreError(401, "WORKER_SIGNATURE_INVALID");
    return worker;
  }

  public async workerEvent(worker: WorkerRecord, state: string, detail: Record<string, unknown> = {}) {
    await this.store.mutate((s) => {
      const w = s.workers[worker.workerId]!;
      w.events = [...w.events, { at: nowIso(), state, detail }].slice(-400);
      const connectionStates: Record<string, WorkerRecord["connection"]> = {
        connecting: "starting", login_required: "login_required", authenticated: "authenticated", available: "available", error: "error",
      };
      if (connectionStates[state]) w.connection = connectionStates[state]!;
      if (state === "login_required") w.loginUrl = String(detail.authUrl ?? "");
      if (state === "authenticated") {
        w.loginUrl = undefined;
        w.runtime = { ...w.runtime, account: (detail.account as Record<string, unknown>) ?? null };
      }
      if (state === "error") {
        w.lastError = String(detail.message ?? "error");
        // A failed job run leaves the runtime usable; only runtime-level errors disable the worker.
        if (detail.jobId) w.connection = "available";
      }
      if (state === "job_starting") w.connection = "busy";
      if (state === "job_completed" || state === "authority_lost") {
        w.connection = "available";
        if (w.currentJobId === detail.jobId) w.currentJobId = undefined;
      }
    });
  }

  public async smokeResult(worker: WorkerRecord, result: Record<string, unknown>) {
    await this.store.mutate((s) => {
      const w = s.workers[worker.workerId]!;
      w.smoke = { passed: result.passed === true, at: nowIso(), threadId: String(result.threadId ?? ""), turnId: String(result.turnId ?? ""), detail: result };
      w.events = [...w.events, { at: nowIso(), state: "smoke_test", detail: result }].slice(-400);
    });
  }

  public async heartbeat(worker: WorkerRecord) {
    await this.store.mutate((s) => {
      s.workers[worker.workerId]!.lastHeartbeatAt = nowIso();
    });
    const jobs = await this.store.read((s) => Object.values(s.jobs));
    const history = jobs.filter((j) => j.assignments.some((a) => a.workerId === worker.workerId)).map((j) => ({ jobId: j.jobId, escrow: j.escrow }));
    for (const job of jobs) {
      if (job.takeover && job.takeover.toWorkerId === worker.workerId && ["requested"].includes(job.takeover.status) && ["confirmed", "skipped"].includes(job.ops[`ens:grant:${worker.address}`]?.status ?? "") && job.ens.workerNames[worker.workerId]) {
        return { assignment: { jobId: job.jobId, phase: "takeover_ack_requested", epoch: job.epoch, takeoverAck: job.takeover.ackRequest }, history };
      }
      const assignment = job.assignments.at(-1);
      const workRemains = job.checkpoints.filter((c) => c.status === "accepted").length < job.spec.milestones.length;
      if (workRemains && job.phase === "running" && job.activeWorkerId === worker.workerId && assignment?.workerId === worker.workerId && ["ready", "active"].includes(assignment.status)) {
        return { assignment: { jobId: job.jobId, phase: "ready", epoch: job.epoch }, history };
      }
    }
    return { assignment: null, history };
  }

  /** Starts the worker runtime as its own process group with only its own env file. */
  public async connectWorker(workerId: string): Promise<{ pid: number; log: string }> {
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(workerId)) throw new CoreError(400, "WORKER_ID_INVALID");
    const envFile = resolve(this.config.repoRoot, `.env.worker-${workerId}`);
    readFileSync(envFile); // must exist; contents are never read into this process
    const existing = await this.store.read((s) => s.workers[workerId]);
    if (existing?.pid && isAlive(existing.pid)) throw new CoreError(409, "WORKER_ALREADY_RUNNING");
    const logDir = join(this.config.dataDir, "workers", workerId);
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const logPath = join(logDir, "worker.log");
    const out = openSync(logPath, "a", 0o600);
    const child = spawn(process.execPath, [`--env-file=${envFile}`, "--import", "tsx", "server/apps/worker/src/codexWorker.ts"], {
      cwd: this.config.repoRoot,
      detached: true,
      stdio: ["ignore", out, out],
      // Deliberately not inheriting the API environment: it holds buyer secrets.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, BATON_API_URL: this.config.apiUrl, BATON_WORKER_ID: workerId },
    });
    child.unref();
    await this.store.mutate((s) => {
      const w = s.workers[workerId];
      if (w) {
        w.pid = child.pid;
        w.connection = "starting";
        w.events = [...w.events, { at: nowIso(), state: "process_started", detail: { pid: child.pid } }].slice(-400);
      }
    });
    return { pid: child.pid!, log: logPath };
  }

  /** Terminates only this worker's runtime process group. Jobs, namespaces and other workers are untouched. */
  public async stopWorker(workerId: string, mode: "kill" | "graceful" = "kill") {
    const worker = await this.store.read((s) => s.workers[workerId]);
    if (!worker?.pid) throw new CoreError(404, "WORKER_PROCESS_UNKNOWN");
    const pid = worker.pid;
    let signalled = false;
    try {
      process.kill(-pid, mode === "kill" ? "SIGKILL" : "SIGTERM");
      signalled = true;
    } catch {
      try {
        process.kill(pid, mode === "kill" ? "SIGKILL" : "SIGTERM");
        signalled = true;
      } catch {
        signalled = false;
      }
    }
    await new Promise((ok) => setTimeout(ok, 1000));
    const alive = isAlive(pid);
    await this.store.mutate((s) => {
      const w = s.workers[workerId]!;
      w.connection = "stopped";
      w.events = [...w.events, { at: nowIso(), state: "process_stopped", detail: { pid, mode, signalled, alive } }].slice(-400);
    });
    return { workerId, pid, mode, signalled, alive };
  }

  private async eligibleWorker(exclude: string[] = []): Promise<WorkerRecord> {
    const workers = await this.store.read((s) => Object.values(s.workers));
    const busy = await this.store.read((s) => new Set(Object.values(s.jobs).filter((j) => !["completed", "failed"].includes(j.phase)).map((j) => j.activeWorkerId)));
    const candidate = workers
      .filter((w) => !exclude.includes(w.workerId))
      .filter((w) => w.connection === "available" && w.smoke?.passed && w.capabilities.includes(`task:${INCIDENT_TRIAGE_TEMPLATE_ID}`))
      .filter((w) => w.pid !== undefined && isAlive(w.pid) && Date.now() - Date.parse(w.lastHeartbeatAt ?? "0") < HEARTBEAT_STALE_MS)
      .filter((w) => !busy.has(w.workerId))
      .sort((a, b) => a.workerId.localeCompare(b.workerId))[0];
    if (!candidate) throw new CoreError(409, "NO_ELIGIBLE_WORKER_AVAILABLE");
    return candidate;
  }

  // -------------------------------------------------------------------------
  // Jobs: submission and provisioning
  // -------------------------------------------------------------------------

  public async submitJob(input: { rewards?: number[]; seed?: string; workerId?: string }): Promise<JobRecord> {
    const rewards = (input.rewards ?? [3, 3, 4]) as [number, number, number];
    if (rewards.length !== 3 || rewards.some((r) => !Number.isInteger(r) || r <= 0)) throw new CoreError(400, "REWARDS_INVALID");
    const version = await this.chain.publicClient.readContract({ address: this.config.escrow, abi: escrowAbi, functionName: "PROTOCOL_VERSION" }).catch(() => undefined);
    if (version !== V2_MARKER) throw new CoreError(503, "ESCROW_NOT_V2");
    const worker = input.workerId ? await this.store.read((s) => s.workers[input.workerId!]) : await this.eligibleWorker();
    if (!worker) throw new CoreError(404, "WORKER_UNKNOWN");
    const jobId = `0x${randomBytes(32).toString("hex")}` as Hex;
    const spec = buildIncidentTriageSpec(input.seed ?? jobId, rewards);
    const decimals = await this.chain.publicClient.readContract({ address: this.config.rewardToken, abi: tokenAbi, functionName: "decimals" });
    const job: JobRecord = {
      jobId,
      taskId: keccak256(toBytes(`baton.task:${jobId}:${INCIDENT_TRIAGE_TEMPLATE_ID}`)),
      termsHash: termsHash(spec),
      createdAt: nowIso(),
      spec,
      rewardsWei: rewards.map((r) => parseUnits(String(r), decimals).toString()),
      acceptanceSpecHashes: spec.milestones.map((m) => acceptanceSpecHash(spec, m)),
      escrow: this.config.escrow,
      rewardToken: this.config.rewardToken,
      buyer: this.buyer,
      ens: { parent: this.config.ensParent, label: `job-${jobId.slice(2, 10)}`, name: `job-${jobId.slice(2, 10)}.${this.config.ensParent}`, workerNames: {} },
      phase: "provisioning",
      readiness: { resources: false, funding: false, execution: false },
      epoch: 0,
      activeWorkerId: worker.workerId,
      assignments: [{ workerId: worker.workerId, address: worker.address, epoch: 1, ensName: "", status: "provisioning", assignedAt: nowIso() }],
      checkpoints: [],
      contentKeys: {},
      ops: {},
    };
    await this.store.mutate((s) => {
      s.jobs[jobId] = job;
      s.workers[worker.workerId]!.currentJobId = jobId;
    });
    this.kick(jobId);
    return job;
  }

  /** Serialized per-job state machine driver; safe to call repeatedly. */
  public kick(jobId: Hex): Promise<void> {
    const existing = this.running.get(jobId);
    if (existing) return existing;
    const run = this.advance(jobId)
      .catch(async (error: Error) => {
        console.error(`[core] job ${jobId} blocked: ${error.message}`);
        await this.store.mutate((s) => {
          if (s.jobs[jobId]) s.jobs[jobId]!.lastError = `${nowIso()} ${error.message}`;
        });
      })
      .finally(() => this.running.delete(jobId));
    this.running.set(jobId, run);
    return run;
  }

  private job(jobId: Hex): Promise<JobRecord> {
    return this.store.read((s) => {
      const job = s.jobs[jobId];
      if (!job) throw new CoreError(404, "JOB_NOT_FOUND");
      return structuredClone(job);
    });
  }

  private patchJob(jobId: Hex, patch: (job: JobRecord) => void) {
    return this.store.mutate((s) => patch(s.jobs[jobId]!));
  }

  private async advance(jobId: Hex): Promise<void> {
    let job = await this.job(jobId);
    await this.patchJob(jobId, (j) => {
      j.lastError = undefined;
    });
    if (job.phase === "provisioning") await this.provision(job);
    job = await this.job(jobId);
    if (job.phase === "takeover") await this.advanceTakeover(job);
    job = await this.job(jobId);
    if (job.phase === "completing") await this.complete(job);
  }

  private async chainJob(jobId: Hex) {
    return this.chain.publicClient.readContract({ address: this.config.escrow, abi: escrowAbi, functionName: "jobs", args: [jobId] });
  }

  private async provision(job: JobRecord) {
    const scope = { jobId: job.jobId };
    const assignment = job.assignments.at(-1)!;
    const total = job.rewardsWei.reduce((a, b) => a + BigInt(b), 0n);
    // 1. Funding prerequisites (test token only; never on mainnet).
    const balance = await this.chain.publicClient.readContract({ address: job.rewardToken, abi: tokenAbi, functionName: "balanceOf", args: [this.buyer] });
    const funded = (await this.chainJob(job.jobId))[0] !== zeroAddress;
    if (!funded && balance < total) {
      assertConfirmed(await this.chain.run(scope, "token:mint", `mint ${total} test reward units to buyer`, async () => ({
        to: job.rewardToken,
        data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [this.buyer, total - balance] }),
      })));
    }
    // 2. ENS namespace, dedicated resolver, job subregistry, JobAuthority adapter.
    const ens = await this.ens.provisionJob({ jobId: job.jobId, label: job.ens.label, escrow: job.escrow, chainId: this.config.chainId });
    await this.patchJob(job.jobId, (j) => Object.assign(j.ens, ens));
    // 3. Worker child name + job-scoped grant.
    const workerName = await this.ens.registerWorkerName({ jobId: job.jobId, jobName: ens.name, registry: ens.registry, resolver: ens.resolver, label: assignment.workerId, worker: assignment.address, workerId: assignment.workerId, epoch: 1 });
    await this.ens.grantWorker({ jobId: job.jobId, jobName: ens.name, resolver: ens.resolver, authority: ens.authority, worker: assignment.address, key: `ens:grant:${assignment.address}` });
    await this.patchJob(job.jobId, (j) => {
      j.ens.workerNames[assignment.workerId] = { name: workerName, address: assignment.address, label: assignment.workerId };
      j.assignments.at(-1)!.ensName = workerName;
    });
    // 4. Epoch-1 content key and writer grant in the buyer key service.
    await this.ensureContentKey(job.jobId, 1);
    await this.grantWriterKey(job.jobId, 1, assignment.address);
    await this.patchJob(job.jobId, (j) => {
      j.readiness.resources = true;
    });
    // 5. Funding.
    const allowance = await this.chain.publicClient.readContract({ address: job.rewardToken, abi: tokenAbi, functionName: "allowance", args: [this.buyer, job.escrow] });
    if (!funded && allowance < total) {
      assertConfirmed(await this.chain.run(scope, "token:approve", `approve escrow for ${total}`, async () => ({
        to: job.rewardToken,
        data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [job.escrow, total] }),
      })));
    }
    const cutoff = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);
    assertConfirmed(await this.chain.run(scope, "escrow:fund", `fund job with ${total} reward units`, async () => ({
      to: job.escrow,
      data: encodeFunctionData({
        abi: escrowAbi,
        functionName: "fundJob",
        args: [job.jobId, job.termsHash, job.taskId, job.rewardToken, ens.authority, this.buyer, cutoff, job.rewardsWei.map(BigInt), job.acceptanceSpecHashes],
      }),
    }), { alreadyDone: async () => ((await this.chainJob(job.jobId))[0] !== zeroAddress ? { funded: true } : undefined) }));
    await this.patchJob(job.jobId, (j) => {
      j.readiness.funding = true;
    });
    // 6. Buyer-authorized assignment.
    assertConfirmed(await this.chain.run(scope, "escrow:assign:1", `assign ${assignment.address} at epoch 1`, async () => ({
      to: job.escrow,
      data: encodeFunctionData({ abi: escrowAbi, functionName: "assignTask", args: [job.jobId, assignment.address] }),
    }), { alreadyDone: async () => ((await this.chainJob(job.jobId))[10] !== zeroAddress ? { assigned: true } : undefined) }));
    await this.ens.setRecords(scope, "ens:records:e1", ens.name, ens.resolver, { texts: { "baton.status": "active", "baton.epoch": "1", "baton.active-worker": workerName } });
    await this.ens.setRecords(scope, `ens:worker-active:${assignment.workerId}:e1`, workerName, ens.resolver, { texts: { "baton.role": "active", "baton.epoch": "1" } });
    // 7. Verify every link before execution readiness.
    const verification = await this.verifyMapping(job.jobId, assignment.workerId, assignment.address, 1);
    await this.patchJob(job.jobId, (j) => {
      j.ops["verify:e1"] = { key: "verify:e1", network: "local", intent: "verify job mapping", status: verification.ok ? "confirmed" : "failed", result: verification, updatedAt: nowIso() };
      if (verification.ok) {
        j.readiness.execution = true;
        j.phase = "running";
        j.epoch = 1;
        j.assignments.at(-1)!.status = "ready";
      }
    });
    if (!verification.ok) throw new Error(`mapping verification failed: ${JSON.stringify(verification.checks)}`);
  }

  public async verifyMapping(jobId: Hex, workerId: string, worker: Address, epoch: number, previous?: Address) {
    const job = await this.job(jobId);
    const chainJob = await this.chainJob(jobId);
    const workerName = job.ens.workerNames[workerId]?.name ?? "";
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
    const resolved = await this.ens.resolveAddress(workerName);
    checks.push({ name: `ENS ${workerName} resolves to worker wallet`, ok: resolved === worker, detail: String(resolved) });
    const jobText = await this.ens.resolveText(job.ens.name, "baton.job");
    checks.push({ name: `ENS ${job.ens.name} baton.job = jobId`, ok: jobText === jobId, detail: String(jobText) });
    const activeText = await this.ens.resolveText(job.ens.name, "baton.active-worker");
    checks.push({ name: "ENS active-worker points at worker name", ok: activeText === workerName, detail: String(activeText) });
    checks.push({ name: "escrow authority is the job adapter", ok: getAddress(chainJob[2]) === job.ens.authority });
    checks.push({ name: "JobAuthority grant for worker", ok: await this.ens.hasGrant(job.ens.authority!, jobId, worker) });
    if (previous) checks.push({ name: "JobAuthority grant revoked for previous worker", ok: !(await this.ens.hasGrant(job.ens.authority!, jobId, previous)) });
    checks.push({ name: `escrow assigned worker at epoch ${epoch}`, ok: getAddress(chainJob[10]) === worker && Number(chainJob[8]) === epoch, detail: `${chainJob[10]}@${chainJob[8]}` });
    const grants = this.keys.listGrants(jobId);
    checks.push({ name: "key-service writer grant for current epoch", ok: grants.some((g) => g.worker === worker.toLowerCase() && g.manifestDigest === writerBinding(jobId, epoch).toLowerCase()) });
    if (previous) checks.push({ name: "key-service grants removed for previous worker", ok: !grants.some((g) => g.worker === previous.toLowerCase()) });
    return { ok: checks.every((c) => c.ok), checks, at: nowIso() };
  }

  // -------------------------------------------------------------------------
  // Content keys (per authority epoch) and key-service grants
  // -------------------------------------------------------------------------

  private wrap(keyHex: string, aad: string): string {
    const kek = Buffer.from(this.config.keyEncryptionKey.replace(/^0x/, ""), "hex");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kek, nonce);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(Buffer.from(keyHex.replace(/^0x/, ""), "hex")), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ct]).toString("base64");
  }

  private unwrap(wrapped: string, aad: string): string {
    const kek = Buffer.from(this.config.keyEncryptionKey.replace(/^0x/, ""), "hex");
    const raw = Buffer.from(wrapped, "base64");
    const decipher = createDecipheriv("aes-256-gcm", kek, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(raw.subarray(12, 28));
    return "0x" + Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("hex");
  }

  private async ensureContentKey(jobId: Hex, epoch: number): Promise<{ keyId: string; key: string }> {
    const keyId = `baton:${jobId.slice(2, 18)}:e${epoch}`;
    const aad = `${jobId}:${keyId}`;
    const existing = (await this.job(jobId)).contentKeys[String(epoch)];
    if (existing) return { keyId, key: this.unwrap(existing.wrapped, aad) };
    const key = "0x" + randomBytes(32).toString("hex");
    await this.patchJob(jobId, (j) => {
      j.contentKeys[String(epoch)] = { keyId, wrapped: this.wrap(key, aad) };
    });
    return { keyId, key };
  }

  private async grantWriterKey(jobId: Hex, epoch: number, worker: Address) {
    const job = await this.job(jobId);
    const { keyId, key } = await this.ensureContentKey(jobId, epoch);
    this.keys.grantKey({ jobId, taskId: job.taskId, manifestDigest: writerBinding(jobId, epoch), keyId, worker }, key);
    await this.chain.setOp({ jobId }, `keys:writer:e${epoch}:${worker}`, { intent: `grant epoch-${epoch} writer key to ${worker}`, network: "key-service", status: "confirmed", result: { keyId } });
  }

  private async grantRecoveryKey(jobId: Hex, manifestDigest: Hex, keyEpoch: number, worker: Address) {
    const job = await this.job(jobId);
    const { keyId, key } = await this.ensureContentKey(jobId, keyEpoch);
    this.keys.grantKey({ jobId, taskId: job.taskId, manifestDigest, keyId, worker }, key);
    await this.chain.setOp({ jobId }, `keys:recovery:${manifestDigest}:${worker}`, { intent: `grant recovery of accepted checkpoint ${manifestDigest} to ${worker}`, network: "key-service", status: "confirmed", result: { keyId, keyEpoch } });
  }

  // -------------------------------------------------------------------------
  // Worker-facing job context, offers and acceptance
  // -------------------------------------------------------------------------

  public async workerContext(worker: WorkerRecord, jobId: Hex) {
    const job = await this.job(jobId);
    const assignment = [...job.assignments].reverse().find((a) => a.workerId === worker.workerId);
    const isTakeoverTarget = job.takeover?.toWorkerId === worker.workerId && job.takeover.status !== "failed";
    if (!isTakeoverTarget && (!assignment || !["ready", "active"].includes(assignment.status))) throw new CoreError(403, "WORKER_NOT_AUTHORIZED_FOR_JOB");
    const [head, sequence, manifestRef] = await this.chain.publicClient.readContract({ address: job.escrow, abi: escrowAbi, functionName: "acceptedCheckpoint", args: [jobId] });
    const chainJob = await this.chainJob(jobId);
    const epoch = Number(chainJob[8]);
    const accepted = job.checkpoints.find((c) => c.status === "accepted" && c.manifestDigest.toLowerCase() === head.toLowerCase());
    return {
      jobId,
      taskId: job.taskId,
      termsHash: job.termsHash,
      chainId: this.config.chainId,
      escrow: job.escrow,
      epoch,
      phase: job.phase,
      spec: job.spec,
      acceptanceSpecHashes: job.acceptanceSpecHashes,
      nextMilestone: Number(chainJob[9]),
      acceptedHead: head,
      acceptedSequence: Number(sequence),
      acceptedManifestRef: manifestRef,
      writerKey: { keyId: job.contentKeys[String(epoch)]?.keyId ?? "", manifestDigest: writerBinding(jobId, epoch) },
      recoveryKey: accepted ? { keyId: accepted.keyId, manifestDigest: head } : undefined,
      ensName: job.ens.name,
    };
  }

  public async submitOffer(worker: WorkerRecord, jobId: Hex, body: { offer: Record<string, string | number>; signature: Hex; keyId: string; arkiv?: { manifestTx?: Hex; owner?: Address; expiresAt?: string; newArtifacts?: string[] } }) {
    const job = await this.job(jobId);
    const o = body.offer;
    const offer = {
      jobId: o.jobId as Hex, taskId: o.taskId as Hex, termsHash: o.termsHash as Hex, producer: getAddress(String(o.producer)), epoch: BigInt(o.epoch!), milestone: Number(o.milestone),
      acceptanceSpecHash: o.acceptanceSpecHash as Hex, expectedHead: o.expectedHead as Hex, newHead: o.newHead as Hex, manifestRef: String(o.manifestRef), sequence: BigInt(o.sequence!), nonce: BigInt(o.nonce!), expiry: BigInt(o.expiry!),
    };
    // Protected-action gate: signer must be the registered wallet AND the escrow's current worker/epoch.
    const signer = await recoverTypedDataAddress({ domain: { ...BATON_DOMAIN, chainId: this.config.chainId, verifyingContract: job.escrow }, types: OFFER_TYPES, primaryType: "MilestoneOffer", message: offer, signature: body.signature });
    if (signer !== worker.address || offer.producer !== worker.address) throw new CoreError(403, "OFFER_SIGNER_MISMATCH");
    const chainJob = await this.chainJob(jobId);
    if (getAddress(chainJob[10]) !== worker.address || BigInt(chainJob[8]) !== offer.epoch) throw new CoreError(403, "STALE_WORKER_OR_EPOCH");
    if (offer.jobId !== jobId || offer.taskId !== job.taskId || offer.termsHash !== job.termsHash) throw new CoreError(400, "OFFER_TERMS_MISMATCH");
    if (offer.milestone !== Number(chainJob[9]) || offer.expectedHead.toLowerCase() !== chainJob[11].toLowerCase()) throw new CoreError(409, "OFFER_HEAD_OR_MILESTONE_STALE");
    if (offer.acceptanceSpecHash !== job.acceptanceSpecHashes[offer.milestone]) throw new CoreError(400, "ACCEPTANCE_SPEC_MISMATCH");
    const keyEpoch = Number(offer.epoch);
    const content = job.contentKeys[String(keyEpoch)];
    if (!content || content.keyId !== body.keyId) throw new CoreError(400, "KEY_ID_MISMATCH");
    const key = await this.ensureContentKey(jobId, keyEpoch);
    // Buyer readback: exact Arkiv entity, digest, decryption, and manifest bindings.
    const checks: CheckpointRecord["checks"] = [];
    let files: Record<string, string> = {};
    let recoveredFrom: unknown;
    try {
      const manifest = await this.arkiv.readManifest(offer.manifestRef as Hex, offer.newHead, key.key);
      const runtime = (manifest.runtimeState ?? {}) as Record<string, unknown>;
      recoveredFrom = runtime.recoveredFrom;
      checks.push({ name: "manifest job/task binding", ok: manifest.jobId === jobId && manifest.taskId === job.taskId });
      checks.push({ name: "manifest epoch = offer epoch", ok: manifest.epoch === keyEpoch });
      checks.push({ name: "manifest sequence = offer sequence", ok: BigInt(manifest.sequence) === offer.sequence });
      checks.push({ name: "manifest previous head = accepted head", ok: (manifest.previousAcceptedHead ?? EMPTY_HEAD).toLowerCase() === offer.expectedHead.toLowerCase() });
      checks.push({ name: "manifest writer = authorized producer", ok: String(runtime.writer ?? "").toLowerCase() === worker.address.toLowerCase() });
      const meta = await this.arkiv.getEntityMetadata(offer.manifestRef as Hex);
      checks.push({ name: "Arkiv manifest owned by producer wallet", ok: getAddress(meta.owner) === worker.address, detail: meta.owner });
      for (const reference of manifest.artifacts) {
        const bytes = await this.readArtifactAnyEpoch(job, reference);
        files[reference.artifactId] = Buffer.from(bytes).toString("utf8");
      }
      // Accepted outputs must be carried forward byte-for-byte.
      const previous = job.checkpoints.find((c) => c.status === "accepted" && c.manifestDigest.toLowerCase() === offer.expectedHead.toLowerCase());
      if (previous) {
        const prevKey = await this.ensureContentKey(jobId, previous.epoch);
        const prevManifest = await this.arkiv.readManifest(previous.manifestRef, previous.manifestDigest, prevKey.key);
        for (const reference of prevManifest.artifacts) {
          const now = manifest.artifacts.find((a) => a.artifactId === reference.artifactId);
          checks.push({ name: `accepted output ${reference.artifactId} carried forward unchanged`, ok: now?.contentDigest === reference.contentDigest });
        }
      }
      checks.push(...checkMilestone(job.spec, offer.milestone + 1, files).checks);
    } catch (error) {
      checks.push({ name: "Arkiv readback and decryption", ok: false, detail: (error as Error).message });
      files = {};
    }
    // Would the escrow accept it right now? (eth_call only.)
    const simulation = await this.chain.publicClient.call({ account: this.buyer, to: job.escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: "acceptMilestone", args: [jobId, offer, body.signature] }) })
      .then(() => ({ ok: true }), (error: Error & { shortMessage?: string }) => ({ ok: false, detail: error.shortMessage ?? error.message }));
    checks.push({ name: "escrow acceptMilestone simulation", ...simulation });
    const ok = checks.every((c) => c.ok);
    const record: CheckpointRecord = {
      milestone: offer.milestone + 1,
      sequence: Number(offer.sequence),
      epoch: keyEpoch,
      writer: worker.address,
      workerId: worker.workerId,
      manifestDigest: offer.newHead,
      manifestRef: offer.manifestRef as Hex,
      keyId: body.keyId,
      arkivTx: body.arkiv?.manifestTx,
      arkivOwner: body.arkiv?.owner,
      arkivExpiresAt: body.arkiv?.expiresAt,
      newArtifacts: body.arkiv?.newArtifacts ?? [],
      status: ok ? "verified" : "rejected",
      checks,
      offer: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? v : String(v)])),
      signature: body.signature,
      submittedAt: nowIso(),
      recoveredFrom,
    };
    await this.patchJob(jobId, (j) => {
      j.checkpoints.push(record);
      const a = j.assignments.at(-1);
      if (a?.workerId === worker.workerId && a.status === "ready") a.status = "active";
    });
    return { status: ok ? "verified_awaiting_buyer_approval" : "rejected", checks };
  }

  /**
   * Carried-forward artifacts stay encrypted under the key of the epoch that wrote them.
   * AES-GCM authentication makes trying each of this job's epoch keys safe.
   */
  private async readArtifactAnyEpoch(job: JobRecord, reference: Parameters<ArkivContentStore["readArtifact"]>[0]["reference"]): Promise<Uint8Array> {
    let lastError: unknown;
    for (const epoch of Object.keys(job.contentKeys).map(Number).sort((a, b) => b - a)) {
      const { key } = await this.ensureContentKey(job.jobId, epoch);
      try {
        return await this.arkiv.readArtifact({ jobId: job.jobId, taskId: job.taskId, reference, keyHex: key });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("ARTIFACT_UNREADABLE");
  }

  /** Buyer approval: submits the verified worker-signed offer. Never auto-approves. */
  public async acceptMilestone(jobId: Hex, milestone: number) {
    const job = await this.job(jobId);
    const checkpoint = [...job.checkpoints].reverse().find((c) => c.milestone === milestone && c.status === "verified");
    if (!checkpoint) throw new CoreError(409, "NO_VERIFIED_CHECKPOINT_FOR_MILESTONE");
    const o = checkpoint.offer;
    const offer = {
      jobId: o.jobId as Hex, taskId: o.taskId as Hex, termsHash: o.termsHash as Hex, producer: getAddress(String(o.producer)), epoch: BigInt(o.epoch!), milestone: Number(o.milestone),
      acceptanceSpecHash: o.acceptanceSpecHash as Hex, expectedHead: o.expectedHead as Hex, newHead: o.newHead as Hex, manifestRef: String(o.manifestRef), sequence: BigInt(o.sequence!), nonce: BigInt(o.nonce!), expiry: BigInt(o.expiry!),
    };
    const op = assertConfirmed(await this.chain.run({ jobId }, `escrow:accept:m${milestone}`, `accept milestone ${milestone} from ${offer.producer}`, async () => ({
      to: job.escrow,
      data: encodeFunctionData({ abi: escrowAbi, functionName: "acceptMilestone", args: [jobId, offer, checkpoint.signature] }),
    }), {
      alreadyDone: async () => ((await this.chainJob(jobId))[9] >= milestone ? { accepted: true } : undefined),
    }));
    const [head] = await this.chain.publicClient.readContract({ address: job.escrow, abi: escrowAbi, functionName: "acceptedCheckpoint", args: [jobId] });
    if (head.toLowerCase() !== checkpoint.manifestDigest.toLowerCase()) throw new Error("escrow head does not match the accepted checkpoint");
    await this.patchJob(jobId, (j) => {
      const c = j.checkpoints.find((x) => x.manifestDigest === checkpoint.manifestDigest)!;
      c.status = "accepted";
      c.acceptTx = op.txHash;
    });
    // ENS stores a pointer only: sequence, digest and Arkiv entity, never content or keys.
    await this.ens.setRecords({ jobId }, `ens:checkpoint:s${checkpoint.sequence}`, job.ens.name, job.ens.resolver!, {
      texts: { "baton.checkpoint": `${checkpoint.sequence}:${checkpoint.manifestDigest}:arkiv:${checkpoint.manifestRef}` },
    });
    if (milestone === job.spec.milestones.length) {
      await this.patchJob(jobId, (j) => {
        j.phase = "completing";
      });
      this.kick(jobId);
    }
    return { milestone, txHash: op.txHash, head };
  }

  // -------------------------------------------------------------------------
  // Buyer-authorized takeover
  // -------------------------------------------------------------------------

  public async requestTakeover(jobId: Hex, toWorkerId?: string) {
    const job = await this.job(jobId);
    if (job.phase !== "running") throw new CoreError(409, `JOB_NOT_RUNNING (${job.phase})`);
    const from = job.assignments.at(-1)!;
    const successor = toWorkerId ? await this.store.read((s) => s.workers[toWorkerId]) : await this.eligibleWorker([from.workerId]);
    if (!successor || successor.workerId === from.workerId) throw new CoreError(400, "SUCCESSOR_INVALID");
    if (!successor.smoke?.passed) throw new CoreError(409, "SUCCESSOR_NOT_VERIFIED");
    const chainJob = await this.chainJob(jobId);
    await this.patchJob(jobId, (j) => {
      j.phase = "takeover";
      j.takeover = {
        fromWorkerId: from.workerId,
        toWorkerId: successor.workerId,
        requestedAt: nowIso(),
        expectedHead: chainJob[11],
        fromEpoch: Number(chainJob[8]),
        ackRequest: {
          nonce: BigInt("0x" + randomBytes(16).toString("hex")).toString(),
          expiry: Math.floor(Date.now() / 1000) + 3 * 3600,
          compatibilityReport: COMPATIBILITY_REPORT,
          servicePolicy: SERVICE_POLICY,
          epoch: Number(chainJob[8]),
          expectedHead: chainJob[11],
        },
        status: "requested",
      };
    });
    await this.store.mutate((s) => {
      s.workers[successor.workerId]!.currentJobId = jobId;
    });
    this.kick(jobId);
    return (await this.job(jobId)).takeover;
  }

  public async takeoverAck(worker: WorkerRecord, jobId: Hex, body: { ack: Record<string, string>; signature: Hex }) {
    const job = await this.job(jobId);
    const t = job.takeover;
    if (!t || t.toWorkerId !== worker.workerId || t.status !== "requested") throw new CoreError(409, "NO_PENDING_TAKEOVER_FOR_WORKER");
    const a = body.ack;
    const ack = {
      jobId: a.jobId as Hex, taskId: a.taskId as Hex, termsHash: a.termsHash as Hex, successor: getAddress(a.successor!), epoch: BigInt(a.epoch!), expectedHead: a.expectedHead as Hex,
      compatibilityReport: a.compatibilityReport as Hex, servicePolicy: a.servicePolicy as Hex, nonce: BigInt(a.nonce!), expiry: BigInt(a.expiry!),
    };
    const signer = await recoverTypedDataAddress({ domain: { ...BATON_DOMAIN, chainId: this.config.chainId, verifyingContract: job.escrow }, types: TAKEOVER_TYPES, primaryType: "TakeoverAck", message: ack, signature: body.signature });
    if (signer !== worker.address || ack.successor !== worker.address) throw new CoreError(403, "ACK_SIGNER_MISMATCH");
    if (ack.nonce.toString() !== t.ackRequest.nonce || ack.expectedHead.toLowerCase() !== t.expectedHead.toLowerCase() || Number(ack.epoch) !== t.fromEpoch) throw new CoreError(400, "ACK_BINDING_MISMATCH");
    await this.patchJob(jobId, (j) => {
      j.takeover!.ack = { message: a, signature: body.signature };
      j.takeover!.status = "ack_signed";
    });
    this.kick(jobId);
    return { status: "ack_recorded" };
  }

  private async advanceTakeover(job: JobRecord) {
    const scope = { jobId: job.jobId };
    const t = job.takeover!;
    const from = job.assignments.find((a) => a.workerId === t.fromWorkerId && a.epoch === t.fromEpoch)!;
    const successor = await this.store.read((s) => s.workers[t.toWorkerId]!);
    const newEpoch = t.fromEpoch + 1;
    // 1. Stop new acceptance for the outgoing worker.
    if (t.status === "requested") {
      assertConfirmed(await this.chain.run(scope, `escrow:drain:${t.fromEpoch}`, `drain epoch ${t.fromEpoch}`, async () => ({
        to: job.escrow,
        data: encodeFunctionData({ abi: escrowAbi, functionName: "drainTask", args: [job.jobId] }),
      }), { alreadyDone: async () => {
        const c = await this.chainJob(job.jobId);
        return c[14] || Number(c[8]) > t.fromEpoch ? { drained: true } : undefined;
      } }));
      // 2. Successor child name and job-scoped grant (required by the escrow for takeover).
      const name = await this.ens.registerWorkerName({ jobId: job.jobId, jobName: job.ens.name, registry: job.ens.registry!, resolver: job.ens.resolver!, label: successor.workerId, worker: successor.address, workerId: successor.workerId, epoch: newEpoch });
      await this.ens.grantWorker({ jobId: job.jobId, jobName: job.ens.name, resolver: job.ens.resolver!, authority: job.ens.authority!, worker: successor.address, key: `ens:grant:${successor.address}` });
      await this.patchJob(job.jobId, (j) => {
        j.ens.workerNames[successor.workerId] = { name, address: successor.address, label: successor.workerId };
      });
      return; // wait for the successor's signed acknowledgement (heartbeat delivers the request)
    }
    if (t.status === "ack_signed") {
      const a = t.ack!.message;
      const ack = {
        jobId: a.jobId as Hex, taskId: a.taskId as Hex, termsHash: a.termsHash as Hex, successor: getAddress(a.successor!), epoch: BigInt(a.epoch!), expectedHead: a.expectedHead as Hex,
        compatibilityReport: a.compatibilityReport as Hex, servicePolicy: a.servicePolicy as Hex, nonce: BigInt(a.nonce!), expiry: BigInt(a.expiry!),
      };
      assertConfirmed(await this.chain.run(scope, `escrow:takeover:e${newEpoch}`, `takeover to ${successor.address} at epoch ${newEpoch}`, async () => ({
        to: job.escrow,
        data: encodeFunctionData({ abi: escrowAbi, functionName: "takeover", args: [job.jobId, ack, t.ack!.signature] }),
      }), { alreadyDone: async () => {
        const c = await this.chainJob(job.jobId);
        return getAddress(c[10]) === successor.address && Number(c[8]) === newEpoch ? { takenOver: true } : undefined;
      } }));
      await this.patchJob(job.jobId, (j) => {
        j.takeover!.status = "taken_over";
        j.epoch = newEpoch;
        j.activeWorkerId = successor.workerId;
        for (const x of j.assignments) if (x.workerId === from.workerId && x.epoch === t.fromEpoch) {
          x.status = "replaced";
          x.endedAt = nowIso();
        }
        if (!j.assignments.some((x) => x.workerId === successor.workerId && x.epoch === newEpoch)) {
          j.assignments.push({ workerId: successor.workerId, address: successor.address, epoch: newEpoch, ensName: j.ens.workerNames[successor.workerId]!.name, status: "provisioning", assignedAt: nowIso() });
        }
      });
    }
    const current = await this.job(job.jobId);
    if (current.takeover!.status !== "taken_over") return;
    // 3. Revoke the stale worker's future authority: ENS grant and key-service grants.
    await this.ens.revokeWorker({ jobId: job.jobId, resolver: job.ens.resolver!, authority: job.ens.authority!, worker: from.address, key: `ens:revoke:${from.address}` });
    const removed = this.keys.revokeWorkerGrants(job.jobId, from.address);
    await this.chain.setOp(scope, `keys:revoke:${from.address}`, { intent: `revoke key-service grants of ${from.address}`, network: "key-service", status: "confirmed", result: { removed } });
    // 4. Fresh epoch key for the successor's writes; recovery grant for the exact accepted head.
    await this.ensureContentKey(job.jobId, newEpoch);
    await this.grantWriterKey(job.jobId, newEpoch, successor.address);
    const accepted = current.checkpoints.find((c) => c.status === "accepted" && c.manifestDigest.toLowerCase() === t.expectedHead.toLowerCase());
    if (accepted) await this.grantRecoveryKey(job.jobId, accepted.manifestDigest, accepted.epoch, successor.address);
    // 5. Discovery records (ENS is discovery, the escrow is authority).
    const successorName = current.ens.workerNames[successor.workerId]!.name;
    await this.ens.setRecords(scope, `ens:records:e${newEpoch}`, job.ens.name, job.ens.resolver!, { texts: { "baton.epoch": String(newEpoch), "baton.active-worker": successorName } });
    await this.ens.setRecords(scope, `ens:worker-replaced:${from.workerId}:e${t.fromEpoch}`, current.ens.workerNames[from.workerId]!.name, job.ens.resolver!, { texts: { "baton.role": "replaced" } });
    await this.ens.setRecords(scope, `ens:worker-active:${successor.workerId}:e${newEpoch}`, successorName, job.ens.resolver!, { texts: { "baton.role": "active", "baton.epoch": String(newEpoch) } });
    // 6. Verify before admitting the successor to protected work.
    const verification = await this.verifyMapping(job.jobId, successor.workerId, successor.address, newEpoch, from.address);
    await this.patchJob(job.jobId, (j) => {
      j.ops[`verify:e${newEpoch}`] = { key: `verify:e${newEpoch}`, network: "local", intent: "verify takeover mapping", status: verification.ok ? "confirmed" : "failed", result: verification, updatedAt: nowIso() };
      if (verification.ok) {
        j.takeover!.status = "completed";
        j.phase = "running";
        j.assignments.at(-1)!.status = "ready";
      }
    });
    if (!verification.ok) throw new Error(`takeover verification failed: ${JSON.stringify(verification.checks.filter((c) => !c.ok))}`);
  }

  // -------------------------------------------------------------------------
  // Completion: revoke authority first, then close, then retire discovery routes
  // -------------------------------------------------------------------------

  private async complete(job: JobRecord) {
    const scope = { jobId: job.jobId };
    const active = job.assignments.at(-1)!;
    await this.ens.revokeWorker({ jobId: job.jobId, resolver: job.ens.resolver!, authority: job.ens.authority!, worker: active.address, key: `ens:revoke:${active.address}` });
    const removed = this.keys.revokeWorkerGrants(job.jobId, active.address);
    await this.chain.setOp(scope, `keys:revoke:${active.address}`, { intent: `revoke key-service grants of ${active.address}`, network: "key-service", status: "confirmed", result: { removed } });
    assertConfirmed(await this.chain.run(scope, "escrow:close", "close completed job", async () => ({
      to: job.escrow,
      data: encodeFunctionData({ abi: escrowAbi, functionName: "close", args: [job.jobId] }),
    }), { alreadyDone: async () => ((await this.chainJob(job.jobId))[15] ? { closed: true } : undefined) }));
    await this.ens.setRecords(scope, "ens:records:completed", job.ens.name, job.ens.resolver!, { texts: { "baton.status": "completed", "baton.active-worker": "" } });
    await this.ens.setRecords(scope, `ens:worker-completed:${active.workerId}`, job.ens.workerNames[active.workerId]!.name, job.ens.resolver!, { texts: { "baton.role": "completed" } });
    await this.patchJob(job.jobId, (j) => {
      j.phase = "completed";
      j.assignments.at(-1)!.status = "completed";
      j.assignments.at(-1)!.endedAt = nowIso();
    });
    await this.store.mutate((s) => {
      for (const w of Object.values(s.workers)) if (w.currentJobId === job.jobId) w.currentJobId = undefined;
    });
  }

  public async reconcile(jobId: Hex) {
    const job = await this.job(jobId);
    const c = this.chain.publicClient;
    const accounting = await c.readContract({ address: job.escrow, abi: escrowAbi, functionName: "accounting", args: [jobId] });
    const escrowBalance = await c.readContract({ address: job.rewardToken, abi: tokenAbi, functionName: "balanceOf", args: [job.escrow] });
    const workers = await Promise.all(job.assignments.map(async (a) => ({
      workerId: a.workerId,
      address: a.address,
      epoch: a.epoch,
      credited: (await c.readContract({ address: job.escrow, abi: escrowAbi, functionName: "credits", args: [jobId, a.address] })).toString(),
      withdrawn: (await c.readContract({ address: job.escrow, abi: escrowAbi, functionName: "withdrawnCredits", args: [jobId, a.address] })).toString(),
    })));
    const [pool, unallocated, outstanding, refunded, withdrawn] = accounting;
    return {
      jobId,
      rewardPool: pool.toString(),
      unallocated: unallocated.toString(),
      outstandingCredits: outstanding.toString(),
      totalWithdrawn: withdrawn.toString(),
      totalRefunded: refunded.toString(),
      conserved: pool === unallocated + outstanding + withdrawn + refunded,
      escrowTokenBalanceAllJobs: escrowBalance.toString(),
      workers,
    };
  }

  public async view(jobId: Hex) {
    const job = await this.job(jobId);
    const { contentKeys, ...rest } = job;
    return { ...rest, contentKeys: Object.fromEntries(Object.entries(contentKeys).map(([e, v]) => [e, { keyId: v.keyId }])), keyGrants: this.keys.listGrants(jobId), running: this.running.has(jobId) };
  }

  public async listWorkers() {
    return this.store.read((s) => Object.values(s.workers).map((w) => ({
      ...w,
      alive: w.pid ? isAlive(w.pid) : false,
      events: w.events.slice(-25),
      runtime: { ...w.runtime, account: maskAccount(w.runtime.account) },
    })));
  }

  public async listJobs() {
    return this.store.read((s) => Object.values(s.jobs).map((j) => ({ jobId: j.jobId, ensName: j.ens.name, phase: j.phase, epoch: j.epoch, activeWorkerId: j.activeWorkerId, readiness: j.readiness, createdAt: j.createdAt, lastError: j.lastError })));
  }
}

function maskAccount(account: Record<string, unknown> | null | undefined) {
  if (!account) return account ?? null;
  const email = typeof account.email === "string" ? account.email.replace(/^(.).*(@.*)$/, "$1***$2") : account.email;
  return { ...account, email };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function require_timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
