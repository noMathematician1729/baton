import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artifactManifestDigest,
  encryptManifest,
  encryptedEnvelopeDigest,
  type CheckpointManifest,
} from "../../../packages/checkpoint/src/index.js";
import type { ArkivContentStore } from "../../../packages/storage/src/arkiv.js";
import { JobStore } from "../../domain/jobs/jobStore.js";
import { EMPTY_HEAD, digest, type CheckpointHead, type Hex, type JobSnapshot } from "../../protocol/v1.js";
import { ArkivCheckpointCandidateVerifier } from "./checkpointCandidateVerifier.js";

const key = "0x" + "11".repeat(32);
const buyer = ("0x" + "1".repeat(40)) as Hex;
const worker = ("0x" + "2".repeat(40)) as Hex;
const storageOwner = ("0x" + "3".repeat(40)) as Hex;
const entityKey = ("0x" + "4".repeat(64)) as Hex;
const keyId = "buyer-key-v1";

test("candidate verifier fetches and validates the exact encrypted package before acceptance", async () => {
  const fixture = createCandidate();
  const verifier = new ArkivCheckpointCandidateVerifier({
    store: fixture.store,
    checkpointKey: key,
    keyId,
    expectedStorageOwner: storageOwner,
  });

  await verifier.verifyCandidate(fixture.input);
  assert.equal(fixture.reads.envelope, 1);
  assert.equal(fixture.reads.metadata, 1);
  assert.equal(fixture.reads.retention, 1);
});

test("candidate verifier recovers the confirmed checkpoint for a drained snapshot refresh", async () => {
  const fixture = createCandidate();
  const verifier = new ArkivCheckpointCandidateVerifier({
    store: fixture.store,
    checkpointKey: key,
    keyId,
    expectedStorageOwner: storageOwner,
  });

  const recovered = await verifier.recoverAcceptedCheckpoint!({
    job: fixture.input.job,
    producer: worker,
    producerEpoch: 1,
    acceptedHead: fixture.input.newHead.manifestDigest,
    acceptedSequence: fixture.input.newHead.sequence,
    acceptedManifestRef: fixture.input.newHead.manifestRef,
  });

  assert.deepEqual(recovered, fixture.input.newHead);
  assert.equal(fixture.reads.envelope, 1);
  assert.equal(fixture.reads.metadata, 1);
  assert.equal(fixture.reads.retention, 1);
});

test("candidate verifier rejects stale rules or unbound content before job acceptance", async () => {
  const stale = createCandidate();
  const verifier = new ArkivCheckpointCandidateVerifier({
    store: stale.store,
    checkpointKey: key,
    keyId,
    expectedStorageOwner: storageOwner,
  });
  await assert.rejects(
    verifier.verifyCandidate({ ...stale.input, acceptanceSpecHash: digest("wrong-rule") as Hex }),
    /ACCEPTANCE_SPEC_MISMATCH/,
  );
  assert.equal(stale.reads.envelope, 0);

  const wrongParent = createCandidate();
  await assert.rejects(
    new ArkivCheckpointCandidateVerifier({
      store: wrongParent.store,
      checkpointKey: key,
      keyId,
      expectedStorageOwner: storageOwner,
    }).verifyCandidate({
      ...wrongParent.input,
      newHead: { ...wrongParent.input.newHead, previousAcceptedHead: ("0x" + "5".repeat(64)) as Hex },
    }),
    /CHECKPOINT_PARENT_MISMATCH/,
  );
  assert.equal(wrongParent.reads.envelope, 0);
});

test("candidate verifier rejects bytes not owned by the buyer's configured Arkiv signer", async () => {
  const fixture = createCandidate(storageOwner.replace(/3/g, "5") as Hex);
  const verifier = new ArkivCheckpointCandidateVerifier({
    store: fixture.store,
    checkpointKey: key,
    keyId,
    expectedStorageOwner: storageOwner,
  });
  await assert.rejects(verifier.verifyCandidate(fixture.input), /ARKIV_ENTITY_OWNERSHIP_OR_EXPIRY_MISMATCH/);
});

function createCandidate(actualOwner: Hex = storageOwner): {
  input: { job: JobSnapshot; acceptanceSpecHash: Hex; expectedHead: Hex; newHead: CheckpointHead };
  store: Pick<ArkivContentStore, "readEnvelope" | "readArtifact" | "getEntityMetadata">;
  reads: { envelope: number; metadata: number; retention: number };
} {
  const snapshot = new JobStore("unused.json").prepareCreate({
    buyer,
    rewardToken: ("0x" + "6".repeat(40)) as Hex,
    verifier: ("0x" + "7".repeat(40)) as Hex,
    rewards: [3n, 4n],
    serviceBudget: 5n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 3n,
  });
  snapshot.terms.jobId = "candidate-job";
  snapshot.terms.task.taskId = "candidate-task";
  snapshot.task.taskId = "candidate-task";
  snapshot.task.epoch = 1;
  snapshot.task.assignedWorker = worker;

  const manifest: CheckpointManifest = {
    schemaVersion: "checkpoint.v1",
    jobId: snapshot.terms.jobId,
    taskId: snapshot.terms.task.taskId,
    epoch: snapshot.task.epoch,
    sequence: 1,
    previousAcceptedHead: null,
    createdAt: new Date().toISOString(),
    adapter: { id: "baton.deterministic-batch", version: "1.0.0", stateSchemaVersion: "1" },
    work: {
      objective: "verify checkpoint candidate",
      constraints: [],
      completed: [],
      decisions: [],
      unresolved: [],
      nextActions: [],
    },
    artifacts: [],
    tools: [],
    externalOperations: [],
  };
  const envelope = encryptManifest(manifest, key, keyId);
  const newHead: CheckpointHead = {
    manifestDigest: encryptedEnvelopeDigest(envelope) as Hex,
    manifestRef: entityKey,
    artifactManifestDigest: artifactManifestDigest(manifest) as Hex,
    schemaVersion: "checkpoint.v1",
    sequence: 1,
    previousAcceptedHead: null,
  };
  const reads = { envelope: 0, metadata: 0, retention: 0 };
  const store: Pick<ArkivContentStore,
    "readEnvelope" | "readArtifact" | "getEntityMetadata" | "getCurrentBlockNumber" | "ensureRetention"> = {
    async readEnvelope(reference, digestValue) {
      reads.envelope += 1;
      assert.equal(reference, entityKey);
      assert.equal(digestValue, newHead.manifestDigest);
      return envelope;
    },
    async readArtifact() {
      throw new Error("NO_ARTIFACTS_EXPECTED");
    },
    async getEntityMetadata(reference) {
      reads.metadata += 1;
      assert.equal(reference, entityKey);
      return { owner: actualOwner, expiresAt: 1000n };
    },
    async getCurrentBlockNumber() { return 100n; },
    async ensureRetention({ entityKeys }) {
      reads.retention += 1;
      assert(entityKeys.includes(entityKey));
      return entityKeys.map((key) => ({
        entityKey: key,
        expiresAt: 1000n,
        renewed: false,
        covered: true,
        renewAtBlock: 900n,
      }));
    },
  };
  return {
    input: {
      job: snapshot,
      acceptanceSpecHash: snapshot.terms.task.milestones[0]!.acceptanceSpecHash,
      expectedHead: EMPTY_HEAD as Hex,
      newHead,
    },
    store,
    reads,
  };
}
