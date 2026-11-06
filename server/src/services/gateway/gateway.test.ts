import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "../../protocol/v1.js";
import { JobStore } from "../../domain/jobs/jobStore.js";
import { Gateway, LocalPaymentProvider, type PaymentResult } from "./gateway.js";
import { OperationLedger } from "../ledger/operationLedger.js";

const worker = ("0x" + "a".repeat(40)) as `0x${string}`;

test("assignment is not recorded locally until confirmed chain state matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-chain-assignment-postcheck-"));
  const jobs = new JobStore(join(root, "jobs.json"));
  const ledger = new OperationLedger(join(root, "ledger.sqlite"));
  try {
    const job = await jobs.create({
      chainJobId: digest("chain-job"),
      chainTaskId: digest("chain-task"),
      buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
      rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
      verifier: ("0x" + "3".repeat(40)) as `0x${string}`,
      rewards: [1n],
      serviceBudget: 0n,
      serviceAsset: "HBAR",
      approvedServices: [],
      perRequestCap: 1n,
    });
    let writes = 0;
    const gateway = new Gateway(jobs, ledger, new LocalPaymentProvider(), {
      async assertCurrentWorker() {},
      async assertAssignedWorker() {},
      async assertAssignmentTransition() { return false; },
      async assertAssignmentConfirmed() { throw new Error("ONCHAIN_ASSIGNMENT_NOT_CONFIRMED"); },
    }, undefined, {
      async assignTask() { writes += 1; },
      async acceptMilestone() {},
      async pause() {},
      async resume() {},
    });

    await assert.rejects(gateway.assign(job.terms.jobId, worker), /ONCHAIN_ASSIGNMENT_NOT_CONFIRMED/);
    assert.equal(writes, 1, "the simulated assignment write must be confirmed before local state advances");
    assert.equal((await jobs.get(job.terms.jobId))?.task.assignedWorker, null);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway rejects input bytes that do not match the immutable operation digest before reserving", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-input-digest-"));
  const jobs = new JobStore(join(root, "jobs.json"));
  const ledger = new OperationLedger(join(root, "ledger.sqlite"));
  try {
    const job = await jobs.create({
      buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
      rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
      verifier: ("0x" + "3".repeat(40)) as `0x${string}`,
      rewards: [1n],
      serviceBudget: 5n,
      serviceAsset: "HBAR",
      approvedServices: ["batch-data-v1"],
      perRequestCap: 3n,
    });
    await ledger.configureBudget(job.terms.jobId, job.servicePolicy);
    await jobs.assign(job.terms.jobId, worker);
    const gateway = new Gateway(jobs, ledger, {
      async submit(): Promise<PaymentResult> { throw new Error("must not submit"); },
      async reconcile() { return { status: "not-settled" }; },
    });

    await assert.rejects(gateway.execute({
      operationId: "input-digest-mismatch",
      jobId: job.terms.jobId,
      taskId: job.task.taskId,
      worker,
      epoch: 1,
      service: "batch-data-v1",
      inputDigest: digest("expected input"),
      inputBytes: Buffer.from("different input"),
      amount: 1n,
      asset: "HBAR",
    }), /INPUT_DIGEST_MISMATCH/);
    assert.equal(await ledger.getOperation("input-digest-mismatch"), undefined);
    assert.deepEqual(await ledger.getBalance(job.terms.jobId), {
      deposits: 5n,
      available: 5n,
      reserved: 0n,
      settledSpend: 0n,
      returnedFunds: 0n,
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway rechecks chain authority at the provider boundary before spending", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-authority-boundary-"));
  const ledger = new OperationLedger(join(root, "ledger.sqlite"));
  try {
    const jobs = new JobStore(join(root, "jobs.json"));
    const job = await jobs.create({
      chainJobId: digest("1"),
      chainTaskId: digest("2"),
      buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
      rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
      verifier: ("0x" + "3".repeat(40)) as `0x${string}`,
      rewards: [1n],
      serviceBudget: 5n,
      serviceAsset: "HBAR",
      approvedServices: ["batch-data-v1"],
      perRequestCap: 3n,
    });
    await ledger.configureBudget(job.terms.jobId, job.servicePolicy);
    await jobs.assign(job.terms.jobId, worker);

    let authorityReads = 0;
    let providerSubmissions = 0;
    const authority = {
      assertCurrentWorker: async () => {
        authorityReads += 1;
        if (authorityReads === 2) throw new Error("WORKER_AUTHORITY_REVOKED");
      },
      assertAssignedWorker: async () => undefined,
    };
    const provider = {
      async submit() {
        providerSubmissions += 1;
        return {
          providerReceipt: "must-not-submit",
          outputDigest: digest("3"),
          outputRef: "local://must-not-submit",
        };
      },
      async reconcile() { return { status: "not-settled" as const }; },
    };
    const gateway = new Gateway(jobs, ledger, provider, authority);
    const request = {
      operationId: "authority-revoked-before-submit",
      jobId: job.terms.jobId,
      taskId: job.task.taskId,
      worker,
      epoch: 1,
      service: "batch-data-v1",
      inputDigest: digest("4"),
      amount: 2n,
      asset: "HBAR",
    };

    await assert.rejects(gateway.execute(request), /WORKER_AUTHORITY_REVOKED/);
    assert.equal(authorityReads, 2, "authority is checked again after reservation and submission journaling");
    assert.equal(providerSubmissions, 0, "revoked work must not reach the provider");
    assert.equal((await ledger.getOperation(request.operationId))?.state, "FAILED");
    assert.deepEqual(await ledger.getBalance(job.terms.jobId), {
      deposits: 5n,
      available: 5n,
      reserved: 0n,
      settledSpend: 0n,
      returnedFunds: 0n,
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("settlement survives output-state persistence failure and restart without resubmitting", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-output-recovery-"));
  const jobsPath = join(root, "jobs.json");
  const ledgerPath = join(root, "ledger.sqlite");
  let ledger = new OperationLedger(ledgerPath);
  let restartedLedger: OperationLedger | undefined;
  try {
    const jobs = new JobStore(jobsPath);
    const job = await jobs.create({
      buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
      rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
      verifier: ("0x" + "3".repeat(40)) as `0x${string}`,
      rewards: [1n],
      serviceBudget: 5n,
      serviceAsset: "HBAR",
      approvedServices: ["batch-data-v1"],
      perRequestCap: 3n,
    });
    await ledger.configureBudget(job.terms.jobId, job.servicePolicy);
    await jobs.assign(job.terms.jobId, worker);

    let submissions = 0;
    let reconciliations = 0;
    const result: PaymentResult = {
      providerReceipt: "fixture-receipt-1",
      outputDigest: digest({ output: "paid bytes" }),
      outputRef: "arkiv://fixture-paid-output/operation-1",
    };
    const provider = {
      async submit() {
        submissions += 1;
        return result;
      },
      async reconcile() {
        reconciliations += 1;
        return { status: "settled" as const, result };
      },
    };

    const transition = ledger.transition.bind(ledger);
    let failOutputWrite = true;
    ledger.transition = async (operationId, next, patch) => {
      if (failOutputWrite && next === "OUTPUT_AVAILABLE") {
        failOutputWrite = false;
        throw new Error("OUTPUT_STATE_WRITE_FAILED");
      }
      return transition(operationId, next, patch);
    };

    const request = {
      operationId: "operation-1",
      jobId: job.terms.jobId,
      taskId: job.task.taskId,
      worker,
      epoch: 1,
      service: "batch-data-v1",
      inputDigest: digest({ input: "batch-1" }),
      amount: 2n,
      asset: "HBAR",
    };
    const gateway = new Gateway(jobs, ledger, provider);

    await assert.rejects(gateway.execute(request), /OUTPUT_STATE_WRITE_FAILED/);
    const settledBeforeRestart = await ledger.getOperation(request.operationId);
    assert.equal(settledBeforeRestart?.state, "SETTLED");
    assert.equal(settledBeforeRestart?.providerReceipt, result.providerReceipt);
    assert.deepEqual(await ledger.getBalance(job.terms.jobId), {
      deposits: 5n,
      available: 3n,
      reserved: 0n,
      settledSpend: 2n,
      returnedFunds: 0n,
    });
    await gateway.drain(job.terms.jobId);
    assert.equal((await ledger.getTaskControl(job.terms.jobId, job.task.taskId))?.state, "DRAINING");
    assert.equal(await gateway.reconcilePendingOperations(job.terms.jobId), true);
    assert.equal((await ledger.getTaskControl(job.terms.jobId, job.task.taskId))?.state, "DRAINED");
    ledger.close();

    restartedLedger = new OperationLedger(ledgerPath);
    const restartedGateway = new Gateway(new JobStore(jobsPath), restartedLedger, provider);
    const recovered = await restartedGateway.execute(request);
    assert.equal(recovered.state, "OUTPUT_AVAILABLE");
    assert.equal(recovered.providerReceipt, result.providerReceipt);
    assert.equal(recovered.outputDigest, result.outputDigest);
    assert.equal(recovered.outputRef, result.outputRef);
    assert.equal(submissions, 1);
    assert.equal(reconciliations, 1);
    assert.deepEqual(await restartedLedger.getBalance(job.terms.jobId), {
      deposits: 5n,
      available: 3n,
      reserved: 0n,
      settledSpend: 2n,
      returnedFunds: 0n,
    });
  } finally {
    ledger.close();
    restartedLedger?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel drain reconciles uncertain payments before reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-cancel-drain-"));
  const ledger = new OperationLedger(join(root, "ledger.sqlite"));
  try {
    const jobs = new JobStore(join(root, "jobs.json"));
    const job = await jobs.create({
      buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
      rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
      verifier: ("0x" + "3".repeat(40)) as `0x${string}`,
      rewards: [1n],
      serviceBudget: 5n,
      serviceAsset: "HBAR",
      approvedServices: ["batch-data-v1"],
      perRequestCap: 3n,
    });
    await ledger.configureBudget(job.terms.jobId, job.servicePolicy);
    await jobs.assign(job.terms.jobId, worker);

    let reconciliation: { status: "unknown" } | { status: "not-settled" } = { status: "unknown" };
    const gateway = new Gateway(jobs, ledger, {
      async submit() { throw new Error("provider response timed out"); },
      async reconcile() { return reconciliation; },
    });
    const request = {
      operationId: "cancel-drain-uncertain-payment",
      jobId: job.terms.jobId,
      taskId: job.task.taskId,
      worker,
      epoch: 1,
      service: "batch-data-v1",
      inputDigest: digest("cancel-drain-input"),
      amount: 2n,
      asset: "HBAR",
    };

    await assert.rejects(gateway.execute(request), /PAYMENT_UNKNOWN/);
    await gateway.drain(job.terms.jobId);
    await assert.rejects(gateway.resume(job.terms.jobId), /CANCEL_DRAIN_REQUIRED/);
    await assert.rejects(gateway.cancelDrain(job.terms.jobId), /UNRESOLVED_OPERATIONS/);
    assert.equal((await ledger.getTaskControl(job.terms.jobId, job.task.taskId))?.state, "DRAINING");
    assert.equal((await jobs.get(job.terms.jobId))?.task.drained, true);

    reconciliation = { status: "not-settled" };
    const reopened = await gateway.cancelDrain(job.terms.jobId);
    assert.equal(reopened.task.drained, false);
    assert.equal(reopened.task.assignedWorker, worker);
    assert.equal(reopened.task.epoch, 1);
    assert.equal((await ledger.getOperation(request.operationId))?.state, "FAILED");
    assert.equal((await ledger.getTaskControl(job.terms.jobId, job.task.taskId))?.state, "RUNNING");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel drain does not reconcile or mutate operations on a running task", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-cancel-running-"));
  const ledger = new OperationLedger(join(root, "ledger.sqlite"));
  try {
    const jobs = new JobStore(join(root, "jobs.json"));
    const job = await jobs.create({
      buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
      rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
      verifier: ("0x" + "3".repeat(40)) as `0x${string}`,
      rewards: [1n],
      serviceBudget: 5n,
      serviceAsset: "HBAR",
      approvedServices: ["batch-data-v1"],
      perRequestCap: 3n,
    });
    await ledger.configureBudget(job.terms.jobId, job.servicePolicy);
    await jobs.assign(job.terms.jobId, worker);

    let reconciliations = 0;
    const gateway = new Gateway(jobs, ledger, {
      async submit() { throw new Error("provider response timed out"); },
      async reconcile() {
        reconciliations += 1;
        return { status: "not-settled" as const };
      },
    });
    const request = {
      operationId: "cancel-drain-running-task",
      jobId: job.terms.jobId,
      taskId: job.task.taskId,
      worker,
      epoch: 1,
      service: "batch-data-v1",
      inputDigest: digest("cancel-drain-running-input"),
      amount: 2n,
      asset: "HBAR",
    };

    await assert.rejects(gateway.execute(request), /PAYMENT_UNKNOWN/);
    await assert.rejects(gateway.cancelDrain(job.terms.jobId), /TASK_NOT_DRAINED/);
    assert.equal(reconciliations, 0);
    assert.equal((await ledger.getOperation(request.operationId))?.state, "UNKNOWN");
    assert.equal((await jobs.get(job.terms.jobId))?.task.drained, false);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
