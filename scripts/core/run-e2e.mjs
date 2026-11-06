#!/usr/bin/env node
// Operator runbook for one fresh two-worker job, executed through the normal BATON API
// (the same calls the `baton` CLI makes). Workers A and B must already be connected.
// The buyer approvals, the termination of A's real process and the takeover request are
// the operator steps; all task work is done by the Codex workers themselves.
//   node scripts/core/run-e2e.mjs            clean run
//   node scripts/core/run-e2e.mjs --drill    also SIGKILL and restart the API while a takeover tx is in flight
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

const root = resolve(import.meta.dirname, "../..");
const env = parse(readFileSync(resolve(root, ".env")));
const api = `http://${env.SERVER_HOST ?? "127.0.0.1"}:${env.SERVER_PORT ?? 4000}`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const started = new Date().toISOString();
const timeline = [];
const step = (name, detail = {}) => {
  const entry = { at: new Date().toISOString(), step: name, ...detail };
  timeline.push(entry);
  console.log(JSON.stringify(entry));
};

const drill = process.argv.includes("--drill");
const drillReport = {};

async function fetchThroughOutage(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt >= 45) throw error;
      await sleep(2000);
    }
  }
}

async function call(method, path, body) {
  const response = await fetchThroughOutage(api + path, { method, headers: { "content-type": "application/json", ...(method === "POST" ? { "x-baton-buyer-token": env.BATON_BUYER_API_TOKEN } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${json.error ?? ""}`);
  return json;
}
const job = (id) => call("GET", `/api/core/jobs/${id}`);
const workers = async () => (await call("GET", "/api/core/workers")).workers;
async function until(label, predicate, timeoutMs = 30 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(4000);
  }
}
const workerEvents = async (id, jobId, state) => (await call("GET", "/api/core/workers")).workers.find((w) => w.workerId === id)?.events.filter((e) => e.detail?.jobId === jobId && (!state || e.state === state)) ?? [];
const fullEvents = (id) => {
  const store = JSON.parse(readFileSync(resolve(root, ".baton-data/core/core-state.json"), "utf8"));
  return store.workers[id]?.events ?? [];
};
async function verified(jobId, m) {
  return until(`milestone ${m} verified`, async () => {
    const j = await job(jobId);
    if (j.lastError) console.error(`  blocked: ${j.lastError}`);
    const cp = [...j.checkpoints].reverse().find((c) => c.milestone === m);
    if (cp?.status === "rejected") throw new Error(`milestone ${m} rejected: ${JSON.stringify(cp.checks.filter((c) => !c.ok))}`);
    return cp?.status === "verified" ? cp : undefined;
  });
}
const claimed = (id, jobId, n) => until(`${id} claim #${n}`, async () => (fullEvents(id).filter((e) => e.state === "claim_confirmed" && e.detail?.jobId === jobId && e.detail?.status === "success").length >= n ? true : undefined), 10 * 60_000);

const ws = await workers();
for (const id of ["a", "b"]) {
  const w = ws.find((x) => x.workerId === id);
  if (!w?.alive || w.connection !== "available" || !w.smoke?.passed) throw new Error(`worker ${id} is not connected and verified; run: npm run baton -- connect ${id}`);
}
step("workers-ready", { a: ws.find((w) => w.workerId === "a").address, b: ws.find((w) => w.workerId === "b").address });

const submitted = await call("POST", "/api/core/jobs", {});
const jobId = submitted.jobId;
step("job-submitted", submitted);
await until("execution ready", async () => {
  const j = await job(jobId);
  if (j.lastError) console.error(`  blocked: ${j.lastError}`);
  return j.phase === "running" && j.readiness.execution;
});
step("job-ready", { epoch: 1 });

const m1 = await verified(jobId, 1);
step("m1-verified", { writer: m1.workerId, manifestDigest: m1.manifestDigest, arkivEntity: m1.manifestRef, arkivTx: m1.arkivTx });
step("m1-accepted", await call("POST", `/api/core/jobs/${jobId}/milestones/1/accept`));
await claimed("a", jobId, 1);
step("a-withdrew-3");
await until("A working on milestone 2", async () => fullEvents("a").some((e) => e.state === "milestone_working" && e.detail?.jobId === jobId && e.detail?.milestone === 2));
await sleep(15_000); // let A make real progress on unfinished work before it fails
step("a-terminated", await call("POST", "/api/core/workers/a/stop", { mode: "kill" }));
step("takeover-requested", { toWorkerId: (await call("POST", `/api/core/jobs/${jobId}/takeover`, { workerId: "b" })).toWorkerId });
if (drill) {
  // Crash the API at the worst moment: a journaled takeover transaction is signed and in flight.
  const inFlight = await until("takeover tx in flight", async () => {
    const op = Object.values((await job(jobId)).ops).find((o) => o.status === "submitted");
    return op ? { key: op.key, txHash: op.txHash } : undefined;
  }, 5 * 60_000);
  const apiPid = execFileSync("lsof", ["-tiTCP:" + (env.SERVER_PORT ?? 4000), "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
  process.kill(Number(apiPid), "SIGKILL");
  const killedAt = new Date().toISOString();
  step("drill-api-killed", { pid: Number(apiPid), inFlight });
  await sleep(10_000); // workers keep running and must ride out the outage
  const out = openSync(resolve(root, ".baton-data/logs/api.log"), "a", 0o600);
  const restarted = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: resolve(root, "server"), detached: true, stdio: ["ignore", out, out] });
  restarted.unref();
  await until("API back", async () => (await fetch(`${api}/api/core/jobs/${jobId}`).catch(() => undefined))?.ok);
  const rejected = await fetch(`${api}/api/core/jobs/${jobId}/takeover`, { method: "POST", headers: { "content-type": "application/json", "x-baton-buyer-token": env.BATON_BUYER_API_TOKEN }, body: JSON.stringify({ workerId: "b" }) });
  const after = await job(jobId);
  drillReport.apiKilledAt = killedAt;
  drillReport.inFlight = inFlight;
  drillReport.mappingSurvivedRestart = after.jobId === jobId && after.ens.name === submitted.ensName && after.takeover?.toWorkerId === "b";
  drillReport.duplicateTakeoverRequestRefused = rejected.status === 409;
  step("drill-api-restarted", { pid: restarted.pid, mappingSurvivedRestart: drillReport.mappingSurvivedRestart, duplicateTakeoverRequestRefused: drillReport.duplicateTakeoverRequestRefused });
}
await until("takeover verified", async () => {
  const j = await job(jobId);
  if (j.lastError) console.error(`  blocked: ${j.lastError}`);
  return j.takeover?.status === "completed";
});
step("takeover-completed", { epoch: (await job(jobId)).epoch });

let stale;
try {
  stale = JSON.parse(execFileSync(process.execPath, ["--env-file=.env.worker-a", "--import", "tsx", "scripts/core/stale-check.ts", jobId], { cwd: root, encoding: "utf8" }));
} catch (error) {
  stale = { allRefused: false, output: String(error.stdout ?? error.message) };
}
step("stale-a-check", { allRefused: stale.allRefused });
if (!stale.allRefused) throw new Error("stale worker check failed");

const m2 = await verified(jobId, 2);
step("m2-verified", { writer: m2.workerId, recoveredFrom: m2.recoveredFrom ?? null, manifestDigest: m2.manifestDigest, arkivEntity: m2.manifestRef });
step("m2-accepted", await call("POST", `/api/core/jobs/${jobId}/milestones/2/accept`));
await claimed("b", jobId, 1);
step("b-withdrew-3");
const m3 = await verified(jobId, 3);
step("m3-verified", { writer: m3.workerId, manifestDigest: m3.manifestDigest, arkivEntity: m3.manifestRef });
step("m3-accepted", await call("POST", `/api/core/jobs/${jobId}/milestones/3/accept`));
await until("job completed", async () => (await job(jobId)).phase === "completed");
await claimed("b", jobId, 2);
step("b-withdrew-4");
const reconcile = await call("GET", `/api/core/jobs/${jobId}/reconcile`);
const amounts = Object.fromEntries(reconcile.workers.map((w) => [w.workerId, { credited: w.credited, withdrawn: w.withdrawn }]));
const ok = reconcile.conserved && reconcile.unallocated === "0" && reconcile.outstandingCredits === "0"
  && amounts.a?.withdrawn === "3000000000000000000" && amounts.b?.withdrawn === "7000000000000000000";
step("reconciled", { ok, ...reconcile });
const duplicateAccept = await fetch(`${api}/api/core/jobs/${jobId}/milestones/3/accept`, { method: "POST", headers: { "content-type": "application/json", "x-baton-buyer-token": env.BATON_BUYER_API_TOKEN }, body: "{}" });
const proof = await job(jobId);
const accepted = proof.checkpoints.filter((c) => c.status === "accepted");
const activity = (id) => fullEvents(id).filter((e) => e.state === "turn_completed" && e.detail?.jobId === jobId);
const realWork = (id) => activity(id).some((e) => e.detail.status === "completed" && e.detail.toolCalls?.some((t) => t === "baton_submit_milestone:completed") && (e.detail.commands > 0 || e.detail.fileChanges > 0));
const hand = accepted.find((c) => c.milestone === 2);
const finalWorkers = await workers();
const checks = {
  duplicateAcceptRefused: duplicateAccept.status === 409,
  aWroteMilestone1AtEpoch1: accepted.find((c) => c.milestone === 1)?.workerId === "a" && accepted.find((c) => c.milestone === 1)?.epoch === 1,
  bWroteMilestones2And3AtEpoch2: [2, 3].every((m) => accepted.find((c) => c.milestone === m)?.workerId === "b" && accepted.find((c) => c.milestone === m)?.epoch === 2),
  bRecoveredAsCheckpointFromEpoch1: hand?.recoveredFrom?.epoch === 1 && hand?.recoveredFrom?.writer === accepted.find((c) => c.milestone === 1)?.writer,
  bDidNotRegenerateAsOutputs: hand ? !hand.newArtifacts.some((file) => ["normalized.json", "clusters.json"].includes(file)) && hand.newArtifacts.includes("analysis.json") : false,
  bothRuntimesDidRealWork: realWork("a") && realWork("b"),
  distinctCodexAccounts: new Set(finalWorkers.filter((w) => ["a", "b"].includes(w.workerId)).map((w) => w.runtime.account?.email)).size === 2,
  bothSandboxesIsolated: finalWorkers.filter((w) => ["a", "b"].includes(w.workerId)).every((w) => w.smoke?.detail?.isolated === true),
  noDuplicateTakeover: Object.keys(proof.ops).filter((k) => k.startsWith("escrow:takeover")).length === 1,
};
step("run-assertions", checks);
if (drill) {
  const restartedOp = proof.ops[drillReport.inFlight.key];
  drillReport.sameTransactionReconciled = restartedOp?.txHash === drillReport.inFlight.txHash && ["confirmed", "skipped"].includes(restartedOp?.status);
  const killedAtMs = Date.parse(drillReport.apiKilledAt);
  const failedBeats = readFileSync(resolve(root, ".baton-data/workers/b/worker.log"), "utf8").split("\n").filter((line) => line.includes('"heartbeat-failed"') && Date.parse(JSON.parse(line).t) >= killedAtMs).length;
  drillReport.bHeartbeatFailuresDuringOutage = failedBeats;
  drillReport.bStayedConnected = failedBeats > 0 && realWork("b");
  checks.drillSameTransactionReconciled = drillReport.sameTransactionReconciled;
  checks.drillMappingSurvivedRestart = drillReport.mappingSurvivedRestart;
  checks.drillDuplicateTakeoverRefused = drillReport.duplicateTakeoverRequestRefused;
  checks.drillWorkerRodeOutOutage = drillReport.bStayedConnected;
  step("drill-assertions", drillReport);
}
const passed = ok && Object.values(checks).every(Boolean);

const finalJob = await job(jobId);
const { spec, ...jobView } = finalJob;
const strip = (events) => events.filter((e) => e.detail?.jobId === jobId).map((e) => ({ at: e.at, state: e.state, detail: e.detail }));
const build = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  trackedChanges: execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean),
  codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
};
const evidence = {
  kind: "baton-core-two-codex-worker-run",
  build,
  started,
  finished: new Date().toISOString(),
  result: passed ? "PASS" : "FAIL",
  mode: drill ? "crash-drill" : "clean",
  assertions: checks,
  drill: drill ? drillReport : undefined,
  network: "sepolia",
  explorer: "https://sepolia.etherscan.io/tx/",
  job: { ...jobView, spec: { templateId: spec.templateId, title: spec.title, milestones: spec.milestones.map((m) => ({ index: m.index, title: m.title, requiredFiles: m.requiredFiles, rewardTokens: m.rewardTokens })) } },
  workers: (await workers()).filter((w) => ["a", "b"].includes(w.workerId)).map((w) => ({ workerId: w.workerId, wallet: w.address, codexAccount: { type: w.runtime.account?.type, planType: w.runtime.account?.planType, accountRef: createHash("sha256").update(String(w.runtime.account?.email)).digest("hex").slice(0, 16) }, smoke: w.smoke })),
  workerActivity: { a: strip(fullEvents("a")), b: strip(fullEvents("b")) },
  staleCheck: stale,
  reconcile,
  timeline,
};
mkdirSync(resolve(root, "evidence/core-runs"), { recursive: true });
const path = resolve(root, `evidence/core-runs/${jobId}.json`);
writeFileSync(path, JSON.stringify(evidence, null, 2));
step("evidence-written", { path: `evidence/core-runs/${jobId}.json`, result: evidence.result });
if (!passed) process.exit(1);
