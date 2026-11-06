import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobStore } from "./jobStore.js";

test("failed JSON persistence does not publish mutated job state in memory or on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-job-store-"));
  const filePath = join(root, "jobs.json");
  let failNextWrite = false;
  const store = new JobStore(filePath, async (path, contents) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error("simulated disk failure");
    }
    const temporary = `${path}.tmp`;
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  });
  try {
    const job = await store.create({
      buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
      rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
      verifier: ("0x" + "3".repeat(40)) as `0x${string}`,
      rewards: [1n],
      serviceBudget: 2n,
      serviceAsset: "HBAR",
      approvedServices: ["batch-data-v1"],
      perRequestCap: 1n,
    });
    const before = await readFile(filePath, "utf8");
    failNextWrite = true;

    await assert.rejects(store.assign(job.terms.jobId, ("0x" + "a".repeat(40)) as `0x${string}`), /simulated disk failure/);
    const inMemory = await store.get(job.terms.jobId);
    assert.equal(inMemory?.task.assignedWorker, null);
    assert.equal(inMemory?.task.epoch, 0);
    assert.equal(await readFile(filePath, "utf8"), before);

    const assigned = await store.assign(job.terms.jobId, ("0x" + "a".repeat(40)) as `0x${string}`);
    assert.equal(assigned.task.epoch, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JobStore rejects already-expired job cutoffs before creating a snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-job-cutoff-"));
  const store = new JobStore(join(root, "jobs.json"));
  try {
    await assert.rejects(store.create({
      buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
      rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
      verifier: ("0x" + "3".repeat(40)) as `0x${string}`,
      rewards: [1n],
      serviceBudget: 2n,
      serviceAsset: "HBAR",
      approvedServices: ["batch-data-v1"],
      perRequestCap: 1n,
      cutoff: Math.floor(Date.now() / 1000) - 1,
    }), /JOB_CUTOFF_INVALID/);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JobStore rejects invalid checkpoint bindings without advancing the head or milestone", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-job-checkpoint-"));
  const store = new JobStore(join(root, "jobs.json"));
  const worker = ("0x" + "a".repeat(40)) as `0x${string}`;
  try {
    const job = await store.create({
      buyer: ("0x" + "1".repeat(40)) as `0x${string}`,
      rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
      verifier: ("0x" + "3".repeat(40)) as `0x${string}`,
      rewards: [1n, 1n],
      serviceBudget: 2n,
      serviceAsset: "HBAR",
      approvedServices: ["batch-data-v1"],
      perRequestCap: 1n,
    });
    await store.assign(job.terms.jobId, worker);

    const base = {
      jobId: job.terms.jobId,
      taskId: job.task.taskId,
      worker,
      epoch: 1,
      acceptanceSpecHash: job.terms.task.acceptanceSpecHash,
      expectedHead: job.task.acceptedHead.manifestDigest,
      newHead: {
        manifestDigest: ("0x" + "a".repeat(64)) as `0x${string}`,
        manifestRef: "arkiv://checkpoint/one",
        artifactManifestDigest: ("0x" + "b".repeat(64)) as `0x${string}`,
        schemaVersion: "checkpoint.v1",
        sequence: 1,
        previousAcceptedHead: null,
      },
    };
    const invalid = [
      { input: { ...base, expectedHead: ("0x" + "f".repeat(64)) as `0x${string}` }, error: /STALE_HEAD/ },
      { input: { ...base, newHead: { ...base.newHead, manifestDigest: "bad" as `0x${string}` } }, error: /CHECKPOINT_DIGEST_INVALID/ },
      { input: { ...base, newHead: { ...base.newHead, schemaVersion: "checkpoint.v2" } }, error: /CHECKPOINT_SCHEMA_UNSUPPORTED/ },
      { input: { ...base, newHead: { ...base.newHead, sequence: 2 } }, error: /CHECKPOINT_SEQUENCE_INVALID/ },
      { input: { ...base, newHead: { ...base.newHead, previousAcceptedHead: ("0x" + "f".repeat(64)) as `0x${string}` } }, error: /CHECKPOINT_PARENT_MISMATCH/ },
      { input: { ...base, newHead: { ...base.newHead, manifestRef: "   " } }, error: /CHECKPOINT_LOCATOR_REQUIRED/ },
    ];
    for (const candidate of invalid) {
      await assert.rejects(store.acceptMilestone(candidate.input), candidate.error);
      const unchanged = await store.get(job.terms.jobId);
      assert.equal(unchanged?.task.nextMilestone, 0);
      assert.equal(unchanged?.task.acceptedHead.sequence, 0);
    }

    const accepted = await store.acceptMilestone(base);
    assert.equal(accepted.task.nextMilestone, 1);
    assert.equal(accepted.task.acceptedHead.manifestDigest, base.newHead.manifestDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
