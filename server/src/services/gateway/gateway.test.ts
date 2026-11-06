import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "../../protocol/v1.js";
import { JobStore } from "../../domain/jobs/jobStore.js";
import { Gateway, type PaymentResult } from "./gateway.js";
import { OperationLedger } from "../ledger/operationLedger.js";

const worker = ("0x" + "a".repeat(40)) as `0x${string}`;

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
