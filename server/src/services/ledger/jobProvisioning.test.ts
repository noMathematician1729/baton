import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobStore } from "../../domain/jobs/jobStore.js";
import { recoverPendingJobProvisions } from "../../app.js";
import { OperationLedger } from "./operationLedger.js";

test("startup recovery completes job and budget provisioning across either-store crash window", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-provision-recovery-"));
  const jobsPath = join(root, "jobs.json");
  const ledgerPath = join(root, "ledger.sqlite");
  let jobs = new JobStore(jobsPath);
  let ledger = new OperationLedger(ledgerPath);
  try {
    const beforeJobWrite = jobs.prepareCreate(createInput());
    const afterJobWrite = jobs.prepareCreate(createInput());

    await ledger.beginJobProvision(beforeJobWrite);
    await ledger.beginJobProvision(afterJobWrite);
    await jobs.importInitial(afterJobWrite);

    ledger.close();
    jobs = new JobStore(jobsPath);
    ledger = new OperationLedger(ledgerPath);
    await recoverPendingJobProvisions(jobs, ledger);

    for (const candidate of [beforeJobWrite, afterJobWrite]) {
      const recovered = await jobs.get(candidate.terms.jobId);
      assert.equal(recovered?.terms.task.taskId, candidate.terms.task.taskId);
      assert.deepEqual(await ledger.getBalance(candidate.terms.jobId), {
        deposits: 7n,
        available: 7n,
        reserved: 0n,
        settledSpend: 0n,
        returnedFunds: 0n,
      });
    }
    assert.deepEqual(await ledger.pendingJobProvisions(), []);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

function createInput() {
  return {
    buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
    rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
    verifier: ("0x" + "3".repeat(40)) as `0x${string}`,
    rewards: [1n],
    serviceBudget: 7n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 2n,
  };
}
