import assert from "node:assert/strict";
import { test } from "node:test";
import { JobStore } from "../domain/jobs/jobStore.js";
import { serialise, type JobSnapshot } from "../protocol/v1.js";
import { parseInitialChainJobSnapshot } from "./chainJobImport.js";

test("chain import accepts a serialized, internally consistent initial job snapshot", () => {
  const snapshot = createSnapshot();
  assert.deepEqual(parseInitialChainJobSnapshot(serialise(snapshot)), snapshot);
});

test("chain import rejects altered terms and snapshots that already advanced locally", () => {
  const changedTerms = structuredClone(createSnapshot());
  changedTerms.terms.task.milestones[0]!.reward += 1n;
  assert.throws(() => parseInitialChainJobSnapshot(changedTerms), /CHAIN_TERMS_SNAPSHOT_MISMATCH/);

  const advanced = structuredClone(createSnapshot());
  advanced.task.nextMilestone = 1;
  assert.throws(() => parseInitialChainJobSnapshot(advanced), /CHAIN_JOB_SNAPSHOT_INVALID/);
});

function createSnapshot(): JobSnapshot {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = new JobStore("unused.json").prepareCreate({
    buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
    rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
    verifier: ("0x" + "4".repeat(40)) as `0x${string}`,
    rewards: [3n, 4n],
    serviceBudget: 5n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 3n,
    cutoff: now + 600,
  });
  snapshot.chainJobId = ("0x" + "1".repeat(64)) as `0x${string}`;
  snapshot.chainTaskId = ("0x" + "2".repeat(64)) as `0x${string}`;
  return snapshot;
}
