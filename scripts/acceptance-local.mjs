import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../server/dist/src/domain/jobs/jobStore.js";
import { OperationLedger } from "../server/dist/src/services/ledger/operationLedger.js";
import { Gateway, LocalPaymentProvider } from "../server/dist/src/services/gateway/gateway.js";

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
let ledger;
let unknownLedger;
let crashLedger;
let restartedLedger;
let guardedLedger;
try {
  const jobs = new JobStore(join(root, "jobs.json"));
  ledger = new OperationLedger(join(root, "payment-ledger.sqlite"));
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

  await gateway.assign(job.terms.jobId, A);
  const firstPayment = await gateway.execute({ operationId: "op-1", jobId: job.terms.jobId, taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_1, amount: 2n, asset: "HBAR" });
  const duplicatePayment = await gateway.execute({ operationId: "op-1", jobId: job.terms.jobId, taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_1, amount: 2n, asset: "HBAR" });
  assert(firstPayment.providerReceipt === duplicatePayment.providerReceipt, "stable operation ID returned a new receipt");
  await gateway.acceptMilestone({ jobId: job.terms.jobId, worker: A, epoch: 1, expectedHead: EMPTY, newHead: { manifestDigest: HEAD_1, manifestRef: "arkiv://1", artifactManifestDigest: spec, schemaVersion: "checkpoint.v1", sequence: 1 } });

  await gateway.drain(job.terms.jobId);
  await expectError(() => gateway.execute({ operationId: "op-stale", jobId: job.terms.jobId, taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_2, amount: 1n, asset: "HBAR" }), "GATEWAY_DRAINED");
  await gateway.takeover({ jobId: job.terms.jobId, successor: B, expectedHead: HEAD_1, expectedEpoch: 1, compatibilityReport: "0x" + "9".repeat(64) });
  await expectError(() => gateway.execute({ operationId: "op-old", jobId: job.terms.jobId, taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_2, amount: 1n, asset: "HBAR" }), "WORKER_NOT_ASSIGNED");

  await gateway.execute({ operationId: "op-2", jobId: job.terms.jobId, taskId, worker: B, epoch: 2, service: "batch-data-v1", inputDigest: INPUT_2, amount: 2n, asset: "HBAR" });
  await gateway.acceptMilestone({ jobId: job.terms.jobId, worker: B, epoch: 2, expectedHead: HEAD_1, newHead: { manifestDigest: HEAD_2, manifestRef: "arkiv://2", artifactManifestDigest: spec, schemaVersion: "checkpoint.v1", sequence: 2 } });
  await gateway.execute({ operationId: "op-3", jobId: job.terms.jobId, taskId, worker: B, epoch: 2, service: "batch-data-v1", inputDigest: INPUT_3, amount: 2n, asset: "HBAR" });
  const completed = await gateway.acceptMilestone({ jobId: job.terms.jobId, worker: B, epoch: 2, expectedHead: HEAD_2, newHead: { manifestDigest: HEAD_3, manifestRef: "arkiv://3", artifactManifestDigest: spec, schemaVersion: "checkpoint.v1", sequence: 3 } });
  const claimA = await jobs.claim(job.terms.jobId, A);
  const claimB = await jobs.claim(job.terms.jobId, B);
  assert(claimA.amount === 3n && claimB.amount === 7n, "worker credits were not conserved");
  await expectError(() => jobs.claim(job.terms.jobId, B), "NO_WITHDRAWABLE_CREDITS");

  const balance = await ledger.getBalance(job.terms.jobId);
  assert(balance?.deposits === 20n && balance.available === 14n && balance.reserved === 0n && balance.settledSpend === 6n, "service budget invariant failed");
  await expectError(() => ledger.reserve({ operationId: "op-1", jobId: job.terms.jobId, taskId, worker: B, epoch: 2, service: "batch-data-v1", inputDigest: INPUT_3, requestFingerprint: "0x" + "f".repeat(64), amount: 2n, asset: "HBAR", nonce: "replay" }), "OPERATION_KEY_REUSED");

  unknownLedger = new OperationLedger(join(root, "unknown-payment-ledger.sqlite"));
  const unknownJobsPath = join(root, "unknown-jobs.json");
  const unknownJobs = new JobStore(unknownJobsPath);
  const unknownJob = await unknownJobs.create({ buyer: "0x" + "1".repeat(40), rewardToken: "0x" + "2".repeat(40), verifier: "0x" + "3".repeat(40), rewards: [1n], serviceBudget: 5n, serviceAsset: "HBAR", approvedServices: ["batch-data-v1"], perRequestCap: 5n });
  await unknownLedger.configureBudget(unknownJob.terms.jobId, unknownJob.servicePolicy);
  await unknownJobs.assign(unknownJob.terms.jobId, A);
  let unknownSubmissions = 0;
  const unknownGateway = new Gateway(unknownJobs, unknownLedger, {
    submit: async () => { unknownSubmissions += 1; throw new Error("facilitator timeout"); },
    reconcile: async () => ({ settled: false }),
  });
  await expectError(() => unknownGateway.execute({ operationId: "op-unknown", jobId: unknownJob.terms.jobId, taskId: unknownJob.task.taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_1, amount: 1n, asset: "HBAR" }), "PAYMENT_UNKNOWN");
  await expectError(() => unknownGateway.execute({ operationId: "op-unknown", jobId: unknownJob.terms.jobId, taskId: unknownJob.task.taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_1, amount: 1n, asset: "HBAR" }), "PAYMENT_UNKNOWN");
  const unknown = await unknownLedger.getOperation("op-unknown");
  const unknownBalance = await unknownLedger.getBalance(unknownJob.terms.jobId);
  assert(unknown?.state === "UNKNOWN" && unknownBalance?.reserved === 1n && unknownBalance.available === 4n && unknownSubmissions === 1, "UNKNOWN retry paid twice or released its reservation");
  unknownLedger.close();
  unknownLedger = new OperationLedger(join(root, "unknown-payment-ledger.sqlite"));
  const restartedUnknownGateway = new Gateway(new JobStore(unknownJobsPath), unknownLedger, {
    submit: async () => { unknownSubmissions += 1; throw new Error("must not resubmit"); },
    reconcile: async () => ({ settled: false }),
  });
  await expectError(() => restartedUnknownGateway.execute({ operationId: "op-unknown", jobId: unknownJob.terms.jobId, taskId: unknownJob.task.taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_1, amount: 1n, asset: "HBAR" }), "PAYMENT_UNKNOWN");
  const restartedUnknownBalance = await unknownLedger.getBalance(unknownJob.terms.jobId);
  assert(unknownSubmissions === 1 && restartedUnknownBalance?.reserved === 1n && restartedUnknownBalance.available === 4n, "UNKNOWN reservation or no-resubmit guarantee changed across SQLite restart");

  const crashJobsPath = join(root, "crash-jobs.json");
  const crashLedgerPath = join(root, "crash-operations.sqlite");
  const crashJobs = new JobStore(crashJobsPath);
  crashLedger = new OperationLedger(crashLedgerPath);
  const crashJob = await crashJobs.create({ buyer: "0x" + "1".repeat(40), rewardToken: "0x" + "2".repeat(40), verifier: "0x" + "3".repeat(40), rewards: [1n, 1n], serviceBudget: 5n, serviceAsset: "HBAR", approvedServices: ["batch-data-v1"], perRequestCap: 5n });
  await crashLedger.configureBudget(crashJob.terms.jobId, crashJob.servicePolicy);
  await crashJobs.assign(crashJob.terms.jobId, A);
  let settledPurchases = 0;
  const durableProviderPurchases = new Map();
  const crashProvider = {
    async submit(request) {
      settledPurchases += 1;
      const result = {
        providerReceipt: "simulated-hedera-receipt:" + request.operationId,
        outputDigest: "0x" + "7".repeat(64),
        outputRef: "arkiv://paid-output/" + request.operationId,
      };
      durableProviderPurchases.set(request.operationId, result);
      throw new Error("SIMULATED_WORKER_CRASH_AFTER_SETTLEMENT");
    },
    async reconcile(operation) {
      return durableProviderPurchases.get(operation.operationId) ?? { settled: false };
    },
  };
  const crashGateway = new Gateway(crashJobs, crashLedger, crashProvider);
  const paidRequestA = { operationId: "op-payment-crash", jobId: crashJob.terms.jobId, taskId: crashJob.task.taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_3, amount: 2n, asset: "HBAR" };
  await expectError(() => crashGateway.execute(paidRequestA), "PAYMENT_UNKNOWN");
  const crashBeforeHandoff = await crashLedger.getOperation(paidRequestA.operationId);
  assert(crashBeforeHandoff?.state === "UNKNOWN", "post-settlement crash did not leave a recoverable UNKNOWN operation");

  // Recreate the gateway/store instances to model process restart before B recovers.
  crashLedger.close();
  const restartedJobs = new JobStore(crashJobsPath);
  restartedLedger = new OperationLedger(crashLedgerPath);
  await restartedJobs.drain(crashJob.terms.jobId);
  await restartedJobs.takeover({ jobId: crashJob.terms.jobId, successor: B, expectedHead: EMPTY, expectedEpoch: 1, compatibilityReport: "0x" + "8".repeat(64) });
  const restartedGateway = new Gateway(restartedJobs, restartedLedger, crashProvider);
  const recovered = await restartedGateway.execute({ ...paidRequestA, worker: B, epoch: 2 });
  const replayed = await restartedGateway.execute({ ...paidRequestA, worker: B, epoch: 2 });
  const recoveredBalance = await restartedLedger.getBalance(crashJob.terms.jobId);
  assert(recovered.state === "OUTPUT_AVAILABLE" && recovered.providerReceipt === "simulated-hedera-receipt:op-payment-crash", "B did not recover A's settled provider result");
  assert(recovered.outputRef === "arkiv://paid-output/op-payment-crash", "recovered paid output reference changed");
  assert(recovered.reusedBy?.some((reuse) => reuse.worker === B && reuse.epoch === 2), "B's authorized reuse was not recorded");
  assert(replayed.providerReceipt === recovered.providerReceipt && settledPurchases === 1, "B retry caused a duplicate provider purchase");
  assert(recoveredBalance?.available === 3n && recoveredBalance.reserved === 0n && recoveredBalance.settledSpend === 2n, "payment-crash recovery changed service budget accounting");

  const guardedJobs = new JobStore(join(root, "guarded-jobs.json"));
  guardedLedger = new OperationLedger(join(root, "guarded-operations.sqlite"));
  const guardedJob = await guardedJobs.create({ chainJobId: "0x" + "c".repeat(64), buyer: "0x" + "1".repeat(40), rewardToken: "0x" + "2".repeat(40), verifier: "0x" + "3".repeat(40), rewards: [1n], serviceBudget: 10n, serviceAsset: "HBAR", approvedServices: ["batch-data-v1"], perRequestCap: 3n });
  await guardedLedger.configureBudget(guardedJob.terms.jobId, guardedJob.servicePolicy);
  const chainState = { worker: A, epoch: 1, grants: new Set([A, B]) };
  const checkedAuthority = {
    async assertCurrentWorker(input) {
      assert(input.chainJobId === guardedJob.chainJobId && input.buyer === guardedJob.terms.buyer, "gateway sent a mismatched chain binding");
      if (chainState.worker.toLowerCase() !== input.worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
      if (chainState.epoch !== input.epoch) throw new Error("STALE_EPOCH");
      if (!chainState.grants.has(input.worker)) throw new Error("WORKER_AUTHORITY_REVOKED");
    },
    async assertAssignedWorker(input) {
      assert(input.chainJobId === guardedJob.chainJobId, "assignment check used the wrong on-chain job");
      if (chainState.worker.toLowerCase() !== input.worker.toLowerCase()) throw new Error("ONCHAIN_ASSIGNMENT_NOT_CONFIRMED");
      if (chainState.epoch !== input.epoch) throw new Error("ONCHAIN_EPOCH_NOT_CONFIRMED");
      if (!chainState.grants.has(input.worker)) throw new Error("WORKER_AUTHORITY_REVOKED");
    },
  };
  let guardedPurchases = 0;
  const countedProvider = {
    async submit(request) {
      guardedPurchases += 1;
      return { providerReceipt: "provider-receipt:" + request.operationId, outputDigest: request.inputDigest, outputRef: "arkiv://" + request.operationId };
    },
    async reconcile() { return { settled: false }; },
  };
  const guardedGateway = new Gateway(guardedJobs, guardedLedger, countedProvider, checkedAuthority);
  assert(guardedGateway.requiresChainAuthority, "chain authority mode was not enabled");
  await guardedGateway.assign(guardedJob.terms.jobId, A);
  chainState.worker = B;
  chainState.epoch = 2;
  await expectError(() => guardedGateway.acceptMilestone({ jobId: guardedJob.terms.jobId, worker: A, epoch: 1, expectedHead: EMPTY, newHead: { manifestDigest: HEAD_1, manifestRef: "arkiv://stale", artifactManifestDigest: guardedJob.terms.task.acceptanceSpecHash, schemaVersion: "checkpoint.v1", sequence: 1 } }), "WORKER_NOT_ASSIGNED");
  assert((await guardedJobs.get(guardedJob.terms.jobId))?.task.nextMilestone === 0, "stale on-chain worker accepted a local checkpoint");
  chainState.worker = A;
  chainState.epoch = 1;
  const reusableIntent = { operationId: "op-chain-payment", jobId: guardedJob.terms.jobId, taskId: guardedJob.task.taskId, worker: A, epoch: 1, service: "batch-data-v1", inputDigest: INPUT_2, amount: 2n, asset: "HBAR" };
  await guardedGateway.execute(reusableIntent);
  await expectError(() => guardedGateway.execute({ ...reusableIntent, operationId: "op-over-cap", amount: 4n }), "REQUEST_CAP_EXCEEDED");
  chainState.worker = B;
  chainState.epoch = 2;
  await expectError(() => guardedGateway.execute({ ...reusableIntent, operationId: "op-stale-chain", inputDigest: INPUT_3 }), "WORKER_NOT_ASSIGNED");
  assert(!(await guardedLedger.getOperation("op-stale-chain")) && guardedPurchases === 1, "stale chain worker or over-cap request reached the provider");
  await guardedGateway.drain(guardedJob.terms.jobId);
  await guardedGateway.takeover({ jobId: guardedJob.terms.jobId, successor: B, expectedHead: EMPTY, expectedEpoch: 1, compatibilityReport: "0x" + "6".repeat(64) });
  const reusedByB = await guardedGateway.execute({ ...reusableIntent, worker: B, epoch: 2 });
  assert(reusedByB.reusedBy?.some((reuse) => reuse.worker === B && reuse.epoch === 2) && guardedPurchases === 1, "B did not reuse A's approved, capped purchase");
  chainState.grants.delete(B);
  await expectError(() => guardedGateway.execute({ ...reusableIntent, operationId: "op-revoked-b", worker: B, epoch: 2 }), "WORKER_AUTHORITY_REVOKED");
  assert(guardedPurchases === 1, "revoked worker request reached the provider");

  console.log(JSON.stringify({ mode: "local", jobId: job.terms.jobId, taskId, acceptedHead: completed.task.acceptedHead.manifestDigest, status: completed.task.status, epoch: completed.task.epoch, claims: { A: claimA.amount.toString(), B: claimB.amount.toString() }, service: { deposits: balance?.deposits.toString(), available: balance?.available.toString(), settledSpend: balance?.settledSpend.toString() }, staleWorker: "rejected", payment: "idempotent", unknown: "reservation-held", paymentCrash: { settledPurchases, recoveredBy: "B", secondCharge: false, outputRef: recovered.outputRef }, liveAuthorityGate: { staleChainWorker: "rejected", revokedGrant: "rejected", overCap: "rejected", purchases: guardedPurchases, bReuse: "no second purchase" } }));
} finally {
  ledger?.close();
  unknownLedger?.close();
  crashLedger?.close();
  restartedLedger?.close();
  guardedLedger?.close();
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
