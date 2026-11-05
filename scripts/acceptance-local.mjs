import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../server/dist/domain/jobs/jobStore.js";
import { OperationLedger } from "../server/dist/services/ledger/operationLedger.js";
import { Gateway, LocalPaymentProvider } from "../server/dist/services/gateway/gateway.js";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const EMPTY = "0x" + "0".repeat(64);
const HEAD_1 = "0x" + "1".repeat(64);
const HEAD_2 = "0x" + "2".repeat(64);
const HEAD_3 = "0x" + "3".repeat(64);
const INPUT_1 = "0x" + "4".repeat(64);
const INPUT_2 = "0x" + "5".repeat(64);
const INPUT_3 = "0x" + "6".repeat(64);

const root = await mkdtemp(join(tmpdir(), "baton-acceptance-"));
try {
  const jobs = new JobStore(join(root, "jobs.json"));
  const ledger = new OperationLedger(join(root, "operations.json"));
  const gateway = new Gateway(jobs, ledger, new LocalPaymentProvider());
  const job = await jobs.create({
    buyer: "0x" + "1".repeat(40),
    rewardToken: "0x" + "2".repeat(40),
    verifier: "0x" + "3".repeat(40),
    rewards: [3n, 3n, 4n],
    serviceBudget: 20n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 5n,
  });
  await ledger.configureBudget(job.terms.jobId, job.servicePolicy);
  const taskId = job.task.taskId;
  const spec = job.terms.task.acceptanceSpecHash;

  await jobs.assign(job.terms.jobId, A);
  const firstPayment = await gateway.execute({ operationId: "op-1", jobId: job.terms.jobId, taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_1, amount: 2n, asset: "HBAR" });
  const duplicatePayment = await gateway.execute({ operationId: "op-1", jobId: job.terms.jobId, taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_1, amount: 2n, asset: "HBAR" });
  assert(firstPayment.providerReceipt === duplicatePayment.providerReceipt, "stable operation ID returned a new receipt");
  await jobs.acceptMilestone({ jobId: job.terms.jobId, worker: A, epoch: 1, expectedHead: EMPTY, newHead: { manifestDigest: HEAD_1, manifestRef: "arkiv://1", artifactManifestDigest: spec, schemaVersion: "checkpoint.v1", sequence: 1 } });

  await jobs.drain(job.terms.jobId);
  await expectError(() => gateway.execute({ operationId: "op-stale", jobId: job.terms.jobId, taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_2, amount: 1n, asset: "HBAR" }), "GATEWAY_DRAINED");
  await jobs.takeover({ jobId: job.terms.jobId, successor: B, expectedHead: HEAD_1, expectedEpoch: 1, compatibilityReport: "0x" + "9".repeat(64) });
  await expectError(() => gateway.execute({ operationId: "op-old", jobId: job.terms.jobId, taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_2, amount: 1n, asset: "HBAR" }), "WORKER_NOT_ASSIGNED");

  await gateway.execute({ operationId: "op-2", jobId: job.terms.jobId, taskId, worker: B, epoch: 2, service: "batch-data-v1", inputDigest: INPUT_2, amount: 2n, asset: "HBAR" });
  await jobs.acceptMilestone({ jobId: job.terms.jobId, worker: B, epoch: 2, expectedHead: HEAD_1, newHead: { manifestDigest: HEAD_2, manifestRef: "arkiv://2", artifactManifestDigest: spec, schemaVersion: "checkpoint.v1", sequence: 2 } });
  await gateway.execute({ operationId: "op-3", jobId: job.terms.jobId, taskId, worker: B, epoch: 2, service: "batch-data-v1", inputDigest: INPUT_3, amount: 2n, asset: "HBAR" });
  const completed = await jobs.acceptMilestone({ jobId: job.terms.jobId, worker: B, epoch: 2, expectedHead: HEAD_2, newHead: { manifestDigest: HEAD_3, manifestRef: "arkiv://3", artifactManifestDigest: spec, schemaVersion: "checkpoint.v1", sequence: 3 } });
  const claimA = await jobs.claim(job.terms.jobId, A);
  const claimB = await jobs.claim(job.terms.jobId, B);
  assert(claimA.amount === 3n && claimB.amount === 7n, "worker credits were not conserved");
  await expectError(() => jobs.claim(job.terms.jobId, B), "NO_WITHDRAWABLE_CREDITS");

  const balance = await ledger.getBalance(job.terms.jobId);
  assert(balance?.deposits === 20n && balance.available === 14n && balance.reserved === 0n && balance.settledSpend === 6n, "service budget invariant failed");
  await expectError(() => ledger.reserve({ operationId: "op-1", jobId: job.terms.jobId, taskId, worker: B, epoch: 2, service: "batch-data-v1", inputDigest: INPUT_3, requestFingerprint: "0x" + "f".repeat(64), amount: 2n, asset: "HBAR", nonce: "replay" }), "OPERATION_KEY_REUSED");

  const unknownLedger = new OperationLedger(join(root, "unknown.json"));
  const unknownJobs = new JobStore(join(root, "unknown-jobs.json"));
  const unknownJob = await unknownJobs.create({ buyer: "0x" + "1".repeat(40), rewardToken: "0x" + "2".repeat(40), verifier: "0x" + "3".repeat(40), rewards: [1n], serviceBudget: 5n, serviceAsset: "HBAR", approvedServices: ["batch-data-v1"], perRequestCap: 5n });
  await unknownLedger.configureBudget(unknownJob.terms.jobId, unknownJob.servicePolicy);
  await unknownJobs.assign(unknownJob.terms.jobId, A);
  const unknownGateway = new Gateway(unknownJobs, unknownLedger, { submit: async () => { throw new Error("facilitator timeout"); }, reconcile: async () => ({ settled: false }) });
  await expectError(() => unknownGateway.execute({ operationId: "op-unknown", jobId: unknownJob.terms.jobId, taskId: unknownJob.task.taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_1, amount: 1n, asset: "HBAR" }), "PAYMENT_UNKNOWN");
  const unknown = await unknownLedger.getOperation("op-unknown");
  const unknownBalance = await unknownLedger.getBalance(unknownJob.terms.jobId);
  assert(unknown?.state === "UNKNOWN" && unknownBalance?.reserved === 1n && unknownBalance.available === 4n, "UNKNOWN did not hold its reservation");

  console.log(JSON.stringify({ mode: "local", jobId: job.terms.jobId, taskId, acceptedHead: completed.task.acceptedHead.manifestDigest, status: completed.task.status, epoch: completed.task.epoch, claims: { A: claimA.amount.toString(), B: claimB.amount.toString() }, service: { deposits: balance?.deposits.toString(), available: balance?.available.toString(), settledSpend: balance?.settledSpend.toString() }, staleWorker: "rejected", payment: "idempotent", unknown: "reservation-held" }));
} finally {
  await rm(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectError(action, expected) {
  try {
    await action();
  } catch (error) {
    if (String(error?.message).startsWith(expected)) return;
    throw new Error(`expected ${expected}, got ${error?.message}`);
  }
  throw new Error(`expected ${expected}, operation succeeded`);
}
