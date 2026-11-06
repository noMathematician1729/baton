#!/usr/bin/env node
// BATON operator CLI for the two-worker core. Talks only to the BATON API.
//   node scripts/core/baton.mjs connect <workerId>     start worker runtime, guide Codex sign-in, wait for smoke test
//   node scripts/core/baton.mjs workers                 list connected workers
//   node scripts/core/baton.mjs submit [--worker a]     submit an incident-triage job (3/3/4 test tokens)
//   node scripts/core/baton.mjs status <jobId>          job mapping, checkpoints, operations
//   node scripts/core/baton.mjs wait <jobId> <cond>     wait for: ready | verified:<m> | completed | takeover-done
//   node scripts/core/baton.mjs accept <jobId> <m>      buyer-approve a verified milestone
//   node scripts/core/baton.mjs stop <workerId>         terminate that worker's runtime process group
//   node scripts/core/baton.mjs takeover <jobId> [workerId]
//   node scripts/core/baton.mjs reconcile <jobId>
//   node scripts/core/baton.mjs activity <workerId>
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

const root = resolve(import.meta.dirname, "../..");
const env = parse(readFileSync(resolve(root, ".env")));
const api = (process.env.BATON_API_URL ?? `http://${env.SERVER_HOST ?? "127.0.0.1"}:${env.SERVER_PORT ?? 4000}`).replace(/\/$/, "");
const token = env.BATON_BUYER_API_TOKEN;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function call(method, path, body) {
  const response = await fetch(api + path, {
    method,
    headers: { "content-type": "application/json", ...(method === "POST" ? { "x-baton-buyer-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${json.error ?? ""}`);
  return json;
}

const print = (value) => console.log(JSON.stringify(value, null, 2));
const worker = async (id) => (await call("GET", "/api/core/workers")).workers.find((w) => w.workerId === id);

async function connect(id) {
  const started = await call("POST", `/api/core/workers/${id}/connect`).catch((error) => {
    if (!String(error.message).includes("WORKER_ALREADY_RUNNING")) throw error;
    return { alreadyRunning: true };
  });
  console.log(`worker ${id}: runtime ${started.alreadyRunning ? "already running" : `started (pid ${started.pid})`}`);
  let shownUrl;
  for (let i = 0; i < 1200; i++) {
    const w = await worker(id);
    if (w?.connection === "login_required" && w.loginUrl && w.loginUrl !== shownUrl) {
      shownUrl = w.loginUrl;
      console.log(`\nSign in to the Codex account for worker ${id} in your browser:\n\n  ${w.loginUrl}\n`);
      if (!process.argv.includes("--no-open")) execFile("open", [w.loginUrl], () => undefined);
    }
    if (w?.smoke && Date.parse(w.smoke.at) > Date.now() - 20 * 60_000 && w.connection === "available") {
      print({ workerId: id, wallet: w.address, account: w.runtime.account, smoke: w.smoke.passed ? "passed" : "failed", smokeThread: w.smoke.threadId, connection: w.connection });
      return;
    }
    if (w?.connection === "error") throw new Error(`worker ${id} error: ${w.lastError}`);
    await sleep(2000);
  }
  throw new Error("timed out waiting for worker to connect");
}

async function wait(jobId, condition) {
  for (let i = 0; i < 3600; i++) {
    const job = await call("GET", `/api/core/jobs/${jobId}`);
    if (job.lastError) console.error(`  [${new Date().toISOString()}] blocked: ${job.lastError}`);
    if (condition === "ready" && job.phase === "running" && job.readiness.execution) return print({ phase: job.phase, epoch: job.epoch, activeWorkerId: job.activeWorkerId });
    if (condition === "completed" && job.phase === "completed") return print({ phase: job.phase });
    if (condition === "takeover-done" && job.takeover?.status === "completed") return print({ takeover: job.takeover.status, epoch: job.epoch, activeWorkerId: job.activeWorkerId });
    if (condition.startsWith("verified:")) {
      const m = Number(condition.split(":")[1]);
      const cp = [...job.checkpoints].reverse().find((c) => c.milestone === m);
      if (cp?.status === "verified" || cp?.status === "accepted") return print({ milestone: m, status: cp.status, writer: cp.workerId, epoch: cp.epoch, manifestDigest: cp.manifestDigest, arkivEntity: cp.manifestRef, checks: cp.checks.length });
      if (cp?.status === "rejected") console.error(`  milestone ${m} candidate rejected: ${JSON.stringify(cp.checks.filter((c) => !c.ok))}`);
    }
    await sleep(5000);
  }
  throw new Error(`timed out waiting for ${condition}`);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "connect": await connect(args[0]); break;
  case "workers": print((await call("GET", "/api/core/workers")).workers.map((w) => ({ workerId: w.workerId, wallet: w.address, account: w.runtime.account, connection: w.connection, alive: w.alive, smoke: w.smoke?.passed, currentJobId: w.currentJobId, lastError: w.lastError }))); break;
  case "submit": print(await call("POST", "/api/core/jobs", args[0] === "--worker" ? { workerId: args[1] } : {})); break;
  case "status": { const { ops, spec, ...rest } = await call("GET", `/api/core/jobs/${args[0]}`); print({ ...rest, spec: { title: spec.title }, ops: Object.values(ops).map((o) => ({ key: o.key, status: o.status, txHash: o.txHash, network: o.network })) }); break; }
  case "wait": await wait(args[0], args[1]); break;
  case "accept": print(await call("POST", `/api/core/jobs/${args[0]}/milestones/${args[1]}/accept`)); break;
  case "stop": print(await call("POST", `/api/core/workers/${args[0]}/stop`, { mode: "kill" })); break;
  case "takeover": print(await call("POST", `/api/core/jobs/${args[0]}/takeover`, args[1] ? { workerId: args[1] } : {})); break;
  case "reconcile": print(await call("GET", `/api/core/jobs/${args[0]}/reconcile`)); break;
  case "retry": print(await call("POST", `/api/core/jobs/${args[0]}/retry`)); break;
  case "activity": print((await worker(args[0]))?.events ?? []); break;
  default: console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 12).join("\n"));
}
