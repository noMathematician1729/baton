import assert from "node:assert/strict";
import { test } from "node:test";
import { JobStore } from "../../domain/jobs/jobStore.js";
import { EMPTY_HEAD, digest, type Hex } from "../../protocol/v1.js";
import { ArkivRetentionMonitor } from "./arkivRetentionMonitor.js";

test("retention monitor verifies confirmed snapshots before renewing accepted packages", async () => {
  const accepted = new JobStore("unused.json").prepareCreate({
    buyer: address("1"), rewardToken: address("2"), verifier: address("3"),
    rewards: [3n], serviceBudget: 5n, serviceAsset: "HBAR", approvedServices: ["batch-data-v1"], perRequestCap: 3n,
  });
  accepted.task.acceptedHead = {
    manifestDigest: digest("a"),
    manifestRef: digest("b"),
    artifactManifestDigest: digest("c"),
    schemaVersion: "checkpoint.v1",
    sequence: 1,
    previousAcceptedHead: null,
  };
  const empty = new JobStore("unused.json").prepareCreate({
    buyer: address("1"), rewardToken: address("2"), verifier: address("3"),
    rewards: [3n], serviceBudget: 5n, serviceAsset: "HBAR", approvedServices: ["batch-data-v1"], perRequestCap: 3n,
  });
  let confirmed = 0;
  let renewed = 0;
  const monitor = new ArkivRetentionMonitor({
    jobs: { async list() { return [accepted, empty]; } } as unknown as JobStore,
    authority: { async assertSnapshotCurrent() { confirmed += 1; } },
    retainer: { async ensureAcceptedCheckpointRetention() { renewed += 1; } },
    intervalMs: 60_000,
  });

  await monitor.runOnce();
  monitor.stop();

  assert.equal(confirmed, 1);
  assert.equal(renewed, 1);
  assert.equal(empty.task.acceptedHead.manifestDigest, EMPTY_HEAD);
});

test("retention monitor skips renewal when the confirmed chain snapshot is stale", async () => {
  const job = new JobStore("unused.json").prepareCreate({
    buyer: address("1"), rewardToken: address("2"), verifier: address("3"),
    rewards: [3n], serviceBudget: 5n, serviceAsset: "HBAR", approvedServices: ["batch-data-v1"], perRequestCap: 3n,
  });
  job.task.acceptedHead = {
    manifestDigest: digest("a"),
    manifestRef: digest("b"),
    artifactManifestDigest: digest("c"),
    schemaVersion: "checkpoint.v1",
    sequence: 1,
    previousAcceptedHead: null,
  };
  let renewals = 0;
  const errors: string[] = [];
  const monitor = new ArkivRetentionMonitor({
    jobs: { async list() { return [job]; } } as unknown as JobStore,
    authority: { async assertSnapshotCurrent() { throw new Error("ONCHAIN_HEAD_MISMATCH"); } },
    retainer: { async ensureAcceptedCheckpointRetention() { renewals += 1; } },
    intervalMs: 60_000,
    onError: (_jobId, error) => errors.push(String(error)),
  });

  await monitor.runOnce();
  monitor.stop();

  assert.equal(renewals, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /ONCHAIN_HEAD_MISMATCH/);
});

function address(character: string): Hex {
  return ("0x" + character.repeat(40)) as Hex;
}
