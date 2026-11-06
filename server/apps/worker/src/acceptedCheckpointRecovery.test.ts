import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encryptChunk, encryptManifest, encryptedEnvelopeDigest, serializeEncryptedEnvelope, artifactManifestDigest } from "../../../packages/checkpoint/src/index.js";
import { createBatchState, runNextBatch } from "../../../packages/runtime/src/index.js";
import { ArkivContentStore } from "../../../packages/storage/src/arkiv.js";
import { JobStore } from "../../../src/domain/jobs/jobStore.js";
import type { ConfirmedTakeoverState } from "../../../src/chain/sepoliaAuthority.js";
import type { Hex, JobSnapshot } from "../../../src/protocol/v1.js";
import { recoverAndAcknowledgeAcceptedCheckpoint } from "./acceptedCheckpointRecovery.js";

const buyer = address("1");
const workerA = address("2");
const storageOwner = address("3");
const keyHex = "0x" + "6a".repeat(32);
const chainJobId = hex32("4");
const chainTaskId = hex32("5");
const escrow = address("6");
const batchArtifact = Buffer.from("recovered batch payload");

test("B recovers the confirmed accepted package, imports runtime state, then acknowledges it", async () => {
  const fixture = await makeFixture();
  const ordering: string[] = [];
  const originalResolve = fixture.keyGrants.resolveGrantedKey.bind(fixture.keyGrants);
  fixture.keyGrants.resolveGrantedKey = async (request) => {
    ordering.push("key-grant");
    return originalResolve(request);
  };
  const originalReadArtifact = fixture.store.readArtifact.bind(fixture.store);
  fixture.store.readArtifact = async (input) => {
    ordering.push("artifact-read");
    return originalReadArtifact(input);
  };

  const result = await recoverAndAcknowledgeAcceptedCheckpoint({
    apiUrl: "http://127.0.0.1:4000",
    chainId: 11155111,
    escrowAddress: escrow,
    job: fixture.job,
    account: fixture.worker,
    authority: {
      async readTakeoverState() { ordering.push("confirmed-head"); return fixture.confirmed; },
      async assertSnapshotCurrent() { ordering.push("snapshot-current"); },
      async assertPreapprovedSuccessor() { ordering.push("successor-grant"); },
    } as never,
    store: fixture.store,
    keyGrants: fixture.keyGrants,
    expectedStorageOwner: storageOwner,
    fetchImpl: async (input, init) => {
      ordering.push("acknowledgement");
      const request = new Request(input, init);
      assert.equal(new URL(request.url).pathname, `/api/jobs/${fixture.job.terms.jobId}/takeover-ack`);
      return new Response(null, { status: 204 });
    },
  });

  assert.deepEqual(result.importedState.runtimeState, fixture.runtimeState);
  assert.deepEqual(Buffer.from(result.recovered.artifacts[0]!.bytes), batchArtifact);
  assert.equal(result.acceptedHead, fixture.confirmed.acceptedHead);
  assert.deepEqual(ordering, ["confirmed-head", "snapshot-current", "successor-grant", "key-grant", "artifact-read", "acknowledgement"]);
});

test("B does not fetch content or acknowledge when the confirmed head differs from the API snapshot", async () => {
  const fixture = await makeFixture();
  let fetches = 0;
  await assert.rejects(recoverAndAcknowledgeAcceptedCheckpoint({
    apiUrl: "http://127.0.0.1:4000",
    chainId: 11155111,
    escrowAddress: escrow,
    job: fixture.job,
    account: fixture.worker,
    authority: {
      async readTakeoverState() { return { ...fixture.confirmed, acceptedHead: hex32("f") }; },
      async assertSnapshotCurrent() {},
      async assertPreapprovedSuccessor() {},
    } as never,
    store: fixture.store,
    keyGrants: fixture.keyGrants,
    expectedStorageOwner: storageOwner,
    fetchImpl: async () => { fetches += 1; return new Response(null, { status: 204 }); },
  }), /CONFIRMED_ACCEPTED_HEAD_MISMATCH/);
  assert.equal(fetches, 0);
});

test("B does not acknowledge a checkpoint whose runtime state fails deterministic import", async () => {
  const fixture = await makeFixture({ corruptRuntime: true });
  let fetches = 0;
  await assert.rejects(recoverAndAcknowledgeAcceptedCheckpoint({
    apiUrl: "http://127.0.0.1:4000",
    chainId: 11155111,
    escrowAddress: escrow,
    job: fixture.job,
    account: fixture.worker,
    authority: {
      async readTakeoverState() { return fixture.confirmed; },
      async assertSnapshotCurrent() {},
      async assertPreapprovedSuccessor() {},
    } as never,
    store: fixture.store,
    keyGrants: fixture.keyGrants,
    expectedStorageOwner: storageOwner,
    fetchImpl: async () => { fetches += 1; return new Response(null, { status: 204 }); },
  }));
  assert.equal(fetches, 0);
});

test("gateway job snapshots decode wire bigints and remain bound to the requested job id", async () => {
  const fixture = await makeFixture();
  const { fetchJobSnapshotFromGateway } = await import("./acceptedCheckpointRecovery.js");
  const snapshot = await fetchJobSnapshotFromGateway({
    apiUrl: "http://127.0.0.1:4000",
    jobId: fixture.job.terms.jobId,
    fetchImpl: async () => Response.json({ job: serializeJob(fixture.job) }),
  });
  assert.equal(snapshot.terms.jobId, fixture.job.terms.jobId);
  assert.equal(snapshot.terms.task.milestones[0]!.reward, 3n);
  await assert.rejects(fetchJobSnapshotFromGateway({
    apiUrl: "http://127.0.0.1:4000",
    jobId: "another-job",
    fetchImpl: async () => Response.json({ job: serializeJob(fixture.job) }),
  }), /GATEWAY_JOB_BINDING_MISMATCH/);
});

async function makeFixture(options: { corruptRuntime?: boolean } = {}) {
  const worker = privateKeyToAccount(generatePrivateKey());
  const jobs = new JobStore("/unused/jobs.json");
  const job = jobs.prepareCreate({
    chainJobId,
    chainTaskId,
    buyer,
    rewardToken: address("7"),
    verifier: address("8"),
    rewards: [3n, 3n, 4n],
    serviceBudget: 20n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 5n,
  });
  job.task.assignedWorker = workerA;
  job.task.epoch = 1;
  job.task.status = "DRAINED";
  job.task.drained = true;
  job.task.nextMilestone = 1;
  job.credits = [{ id: "credit-1", worker: workerA, milestoneId: "milestone-1", amount: 3n, claimed: false }];

  const runtimeState = runNextBatch(createBatchState(job.terms.jobId, job.task.taskId), "batch-1");
  const encryptedArtifact = encryptChunk(
    batchArtifact,
    keyHex,
    `baton:${job.terms.jobId}:${job.task.taskId}:artifact:batch-1:0`,
  );
  const manifest = {
    schemaVersion: "checkpoint.v1" as const,
    jobId: job.terms.jobId,
    taskId: job.task.taskId,
    epoch: 1,
    sequence: 1,
    previousAcceptedHead: null,
    createdAt: new Date().toISOString(),
    adapter: { id: "baton.deterministic-batch", version: "1.0.0", stateSchemaVersion: "1" },
    work: {
      objective: "Process batch 1 before handoff.",
      constraints: [],
      completed: [{ id: "batch-1", summary: "Processed batch 1.", evidence: [] }],
      decisions: [],
      unresolved: [],
      nextActions: ["Process the remaining batches."],
    },
    artifacts: [artifactReference(batchArtifact, encryptedArtifact.bytes)],
    tools: [],
    externalOperations: [],
    runtimeState: options.corruptRuntime ? { ...runtimeState, jobId: "another-job" } : runtimeState,
  };
  const envelope = encryptManifest(manifest, keyHex, "fixture-key-v1");
  const manifestBytes = Buffer.from(serializeEncryptedEnvelope(envelope));
  const manifestDigest = encryptedEnvelopeDigest(envelope);
  const manifestRef = hex32("9");
  const artifactDigest = artifactManifestDigest(manifest);
  job.task.acceptedHead = {
    manifestDigest,
    manifestRef,
    artifactManifestDigest: artifactDigest,
    schemaVersion: "checkpoint.v1",
    sequence: 1,
    previousAcceptedHead: null,
  };
  const confirmed: ConfirmedTakeoverState = {
    assignedWorker: workerA,
    epoch: 1,
    nextMilestone: 1,
    totalCredited: 3n,
    acceptedHead: manifestDigest,
    acceptedSequence: 1,
    acceptedManifestRef: manifestRef,
    paused: false,
    drained: true,
    closed: false,
    expired: false,
    successorGranted: true,
  };

  const store = new ArkivContentStore({
    accessKey: "local-test-only",
    signerPrivateKey: "0x" + "11".repeat(32),
    permissionlessExtension: false,
  });
  const content = new Map<Hex, Uint8Array>([
    [manifestRef, manifestBytes],
    [artifactEntity, encryptedArtifact.bytes],
  ]);
  store.readExact = async (entityKey, expectedDigest) => {
    const payload = content.get(entityKey);
    if (!payload || hash(payload).toLowerCase() !== expectedDigest.toLowerCase()) throw new Error("TEST_ENTITY_DIGEST_MISMATCH");
    return Uint8Array.from(payload);
  };
  store.getEntityMetadata = async () => ({ owner: storageOwner, expiresAt: 999_999_999n });

  const keyGrants = {
    async resolveGrantedKey(request: { manifestDigest: Hex; worker: string; keyId: string }) {
      assert.equal(request.manifestDigest, manifestDigest);
      assert.equal(request.worker.toLowerCase(), worker.address.toLowerCase());
      assert.equal(request.keyId, "fixture-key-v1");
      return keyHex;
    },
  };
  return { job, worker, confirmed, runtimeState, store, keyGrants };
}

const artifactEntity = hex32("a");
function artifactReference(bytes: Buffer, encryptedBytes: Uint8Array) {
  return {
    artifactId: "batch-1",
    mediaType: "application/octet-stream",
    byteLength: bytes.byteLength,
    contentDigest: hash(bytes),
    encrypted: true as const,
    chunks: [{
      index: 0,
      entityKey: artifactEntity,
      ciphertextDigest: hash(encryptedBytes),
      ciphertextBytes: encryptedBytes.byteLength,
      expiresAt: "999999999",
      owner: storageOwner,
    }],
  };
}

function serializeJob(job: JobSnapshot): unknown {
  if (typeof job === "bigint") return `${job}n`;
  if (Array.isArray(job)) return job.map(serializeJob);
  if (job && typeof job === "object") {
    return Object.fromEntries(Object.entries(job).map(([key, value]) => [key, serializeJob(value)]));
  }
  return job;
}

function hash(value: Uint8Array): Hex {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function address(char: string): `0x${string}` {
  return `0x${char.repeat(40)}`;
}

function hex32(char: string): Hex {
  return `0x${char.repeat(64)}`;
}
