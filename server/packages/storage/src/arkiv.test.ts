import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { domain, OFFER_TYPES, type MilestoneOffer } from "../../../src/chain/signing.js";
import {
  artifactManifestDigest,
  encryptedEnvelopeDigest,
  MAX_PLAINTEXT_CHUNK_BYTES,
  type CheckpointManifest,
  type EncryptedEnvelope,
} from "../../checkpoint/src/index.js";
import { batchOneCheckpoint } from "../../checkpoint/src/fixtures.js";
import { ArkivContentStore } from "./arkiv.js";
import { recoverAcceptedPackage } from "./recovery.js";

const storageOwner = ("0x" + "11".repeat(20)) as `0x${string}`;
const boundaryKey = "0x" + "66".repeat(32);
const boundarySigner = privateKeyToAccount(generatePrivateKey());

test("Arkiv content reader can run without the storage-owner signer", async () => {
  const reader = new ArkivContentStore({ accessKey: "test-read-only", permissionlessExtension: false });
  await assert.rejects(reader.writeEncrypted({
    jobId: "job-1",
    taskId: "task-1",
    kind: "artifact",
    contentId: "artifact-1",
    chunkIndex: 0,
    payload: new Uint8Array([1]),
  }), /ARKIV_SIGNER_REQUIRED_FOR_WRITE/);
});

const boundaryFixture = JSON.parse(readFileSync(
  new URL("../../../contracts/test/fixtures/checkpoint-boundary.json", import.meta.url),
  "utf8",
)) as {
  chain: {
    jobId: Hex;
    taskId: Hex;
    termsHash: Hex;
    acceptanceSpecHash: Hex;
    expectedHead: Hex;
    newHead: Hex;
    manifestRef: string;
    sequence: number;
  };
  manifest: CheckpointManifest;
  envelope: EncryptedEnvelope;
  artifactManifestDigest: Hex;
};

function createInMemoryArkivHarness() {
  const store = new ArkivContentStore({
    accessKey: "local-test-only",
    signerPrivateKey: "0x" + "11".repeat(32),
    permissionlessExtension: true,
  });
  const entities = new Map<Hex, Uint8Array>();
  let sequence = 0;
  let writes = 0;

  store.writeEncrypted = async ({ payload }) => {
    writes += 1;
    const id = (++sequence).toString(16).padStart(64, "0");
    const entityKey = ("0x" + id) as Hex;
    const txHash = ("0x" + (sequence + 1000).toString(16).padStart(64, "0")) as Hex;
    const bytes = Uint8Array.from(payload);
    const ciphertextDigest = "0x" + createHash("sha256").update(bytes).digest("hex");
    entities.set(entityKey, bytes);
    return { entityKey, txHash, owner: storageOwner, payloadDigest: ciphertextDigest, ciphertextBytes: bytes.byteLength, expiresAt: 1_000_000n };
  };

  store.readExact = async (entityKey, expectedDigest) => {
    const payload = entities.get(entityKey);
    if (!payload) throw new Error("Arkiv entity not found");
    const digest = "0x" + createHash("sha256").update(payload).digest("hex");
    if (digest !== expectedDigest) throw new Error("Arkiv content digest mismatch");
    return Uint8Array.from(payload);
  };
  store.getEntityMetadata = async () => ({ owner: storageOwner, expiresAt: 1_000_000n });

  return {
    store,
    entities,
    get writes() { return writes; },
  };
}

test("Arkiv artifact chunks encrypt, recover, and reuse unchanged chunks", async () => {
  const harness = createInMemoryArkivHarness();
  const keyHex = "0x" + "22".repeat(32);
  const original = new Uint8Array(200_000).fill(0x61);
  const first = await harness.store.stageArtifact({
    jobId: "job-1",
    taskId: "task-1",
    artifactId: "corpus",
    mediaType: "application/octet-stream",
    plaintext: original,
    keyHex,
  });

  assert.equal(first.chunks.length, 3);
  assert.equal(harness.writes, 3);
  assert.notDeepEqual(
    Buffer.from(harness.entities.get(first.chunks[0]!.entityKey as Hex)!),
    Buffer.from(original.subarray(0, MAX_PLAINTEXT_CHUNK_BYTES)),
  );
  assert.deepEqual(Buffer.from(await harness.store.readArtifact({ jobId: "job-1", taskId: "task-1", reference: first, keyHex })), Buffer.from(original));

  const updated = Uint8Array.from(original);
  updated[updated.length - 1] = 0x62;
  const delta = await harness.store.stageArtifact({
    jobId: "job-1",
    taskId: "task-1",
    artifactId: "corpus",
    mediaType: "application/octet-stream",
    plaintext: updated,
    keyHex,
    previous: first,
  });

  assert.equal(delta.baseDigest, first.contentDigest);
  assert.equal(harness.writes, 4, "the unchanged first two chunks should be reused");
  assert.deepEqual(Buffer.from(await harness.store.readArtifact({ jobId: "job-1", taskId: "task-1", reference: delta, keyHex })), Buffer.from(updated));
});

test("Arkiv artifact staging rejects data above the documented recovery limit before writing", async () => {
  const harness = createInMemoryArkivHarness();
  const { MAX_RECOVERED_ARTIFACT_BYTES } = await import("./arkiv.js");
  await assert.rejects(harness.store.stageArtifact({
    jobId: "job-1",
    taskId: "task-1",
    artifactId: "too-large",
    mediaType: "application/octet-stream",
    plaintext: new Uint8Array(MAX_RECOVERED_ARTIFACT_BYTES + 1),
    keyHex: boundaryKey,
  }), /ARTIFACT_SIZE_LIMIT_EXCEEDED/);
  assert.equal(harness.writes, 0);
});

test("Arkiv artifact recovery reads at most four encrypted chunks concurrently", async () => {
  const harness = createInMemoryArkivHarness();
  const keyHex = "0x" + "33".repeat(32);
  const plaintext = new Uint8Array(MAX_PLAINTEXT_CHUNK_BYTES * 5).fill(0x7a);
  const reference = await harness.store.stageArtifact({
    jobId: "job-1",
    taskId: "task-1",
    artifactId: "bounded-read",
    mediaType: "application/octet-stream",
    plaintext,
    keyHex,
  });
  const readExact = harness.store.readExact.bind(harness.store);
  let currentReads = 0;
  let maximumReads = 0;
  harness.store.readExact = async (entityKey, expectedDigest) => {
    currentReads += 1;
    maximumReads = Math.max(maximumReads, currentReads);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return await readExact(entityKey, expectedDigest);
    } finally {
      currentReads -= 1;
    }
  };

  const recovered = await harness.store.readArtifact({ jobId: "job-1", taskId: "task-1", reference, keyHex });
  assert.equal(Buffer.from(recovered).equals(Buffer.from(plaintext)), true);
  assert.equal(maximumReads, 4);
});

test("Arkiv manifest head commits exact serialized envelope and preserves its locator", async () => {
  const harness = createInMemoryArkivHarness();
  const keyHex = "0x" + "44".repeat(32);
  const staged = await harness.store.stageManifest(batchOneCheckpoint, keyHex, "buyer-key-v1");
  const storedBytes = harness.entities.get(staged.stored.entityKey)!;
  const outerDigest = "0x" + createHash("sha256").update(storedBytes).digest("hex");

  assert.equal(staged.manifestDigest, outerDigest);
  assert.equal(staged.stored.payloadDigest, outerDigest);
  assert.equal(staged.manifestRef, staged.stored.entityKey);
  assert.notEqual(staged.manifestDigest, staged.envelope.ciphertextDigest, "outer payload and inner AES-GCM digests are distinct");
  assert.deepEqual(await harness.store.readManifest(staged.manifestRef, staged.manifestDigest, keyHex), batchOneCheckpoint);
  assert.equal(staged.artifactManifestDigest, "0x" + createHash("sha256").update("[]").digest("hex"));
});

test("shared boundary fixture binds encrypted storage recovery and the signed offer", async () => {
  const { chain, envelope, manifest } = boundaryFixture;
  assert.equal(encryptedEnvelopeDigest(envelope).toLowerCase(), chain.newHead.toLowerCase());
  assert.equal(artifactManifestDigest(manifest).toLowerCase(), boundaryFixture.artifactManifestDigest.toLowerCase());

  const recovered = await recoverAcceptedPackage({
    store: {
      async readEnvelope(entityKey, expectedDigest) {
        assert.equal(entityKey, chain.manifestRef);
        assert.equal(expectedDigest.toLowerCase(), chain.newHead.toLowerCase());
        return envelope;
      },
      async readArtifact() { throw new Error("NO_ARTIFACTS_EXPECTED"); },
      async getEntityMetadata() { return { owner: storageOwner, expiresAt: 10_000n }; },
    },
    keyGrants: {
      async resolveGrantedKey(request) {
        assert.equal(request.jobId, manifest.jobId);
        assert.equal(request.taskId, manifest.taskId);
        assert.equal(request.manifestDigest.toLowerCase(), chain.newHead.toLowerCase());
        assert.equal(request.worker.toLowerCase(), boundarySigner.address.toLowerCase());
        assert.equal(request.keyId, envelope.keyId);
        return boundaryKey;
      },
    },
    accepted: {
      jobId: manifest.jobId,
      taskId: manifest.taskId,
      producerEpoch: manifest.epoch,
      manifestDigest: chain.newHead,
      manifestRef: chain.manifestRef,
      sequence: chain.sequence,
      previousAcceptedHead: manifest.previousAcceptedHead,
      artifactManifestDigest: boundaryFixture.artifactManifestDigest,
    },
    worker: boundarySigner.address,
    expectedStorageOwner: storageOwner,
    supportedAdapters: [manifest.adapter],
    retentionUntilBlock: 9_999n,
  });
  assert.deepEqual(recovered.manifest, manifest);
  assert.equal(recovered.manifestDigest.toLowerCase(), chain.newHead.toLowerCase());
  assert.equal(recovered.manifestRef, chain.manifestRef);

  const offer: MilestoneOffer = {
    jobId: chain.jobId,
    taskId: chain.taskId,
    termsHash: chain.termsHash,
    producer: boundarySigner.address,
    epoch: BigInt(manifest.epoch),
    milestone: 0,
    acceptanceSpecHash: chain.acceptanceSpecHash,
    expectedHead: chain.expectedHead,
    newHead: chain.newHead,
    manifestRef: chain.manifestRef,
    sequence: BigInt(chain.sequence),
    nonce: 1n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 120),
  };
  const offerDomain = domain(11_155_111, "0x5555555555555555555555555555555555555555" as Address);
  const signature = await boundarySigner.signTypedData({
    domain: offerDomain,
    types: OFFER_TYPES,
    primaryType: "MilestoneOffer",
    message: offer,
  });
  assert.equal(await recoverTypedDataAddress({
    domain: offerDomain,
    types: OFFER_TYPES,
    primaryType: "MilestoneOffer",
    message: offer,
    signature,
  }), boundarySigner.address);
});

test("Arkiv artifact recovery rejects a corrupted encrypted chunk", async () => {
  const harness = createInMemoryArkivHarness();
  const reference = await harness.store.stageArtifact({
    jobId: "job-1",
    taskId: "task-1",
    artifactId: "small-file",
    mediaType: "text/plain",
    plaintext: Buffer.from("private fixture"),
    keyHex: "0x" + "33".repeat(32),
  });
  const firstChunk = reference.chunks[0]!;
  const key = firstChunk.entityKey as Hex;
  const corrupted = Uint8Array.from(harness.entities.get(key)!);
  corrupted[corrupted.length - 1] = (corrupted.at(-1) ?? 0) ^ 1;
  harness.entities.set(key, corrupted);

  await assert.rejects(
    harness.store.readArtifact({ jobId: "job-1", taskId: "task-1", reference, keyHex: "0x" + "33".repeat(32) }),
    /digest mismatch/,
  );
});

test("cold recovery fetches only the accepted head and validates scoped key, adapter, artifact, and retention", async () => {
  const harness = createInMemoryArkivHarness();
  const keyHex = "0x" + "55".repeat(32);
  const worker = ("0x" + "22".repeat(20)) as `0x${string}`;
  const plaintext = Buffer.from("accepted paid-work artifact");
  const artifact = await harness.store.stageArtifact({
    jobId: batchOneCheckpoint.jobId,
    taskId: batchOneCheckpoint.taskId,
    artifactId: "result",
    mediaType: "text/plain",
    plaintext,
    keyHex,
  });
  const manifest = { ...batchOneCheckpoint, artifacts: [artifact] };
  const staged = await harness.store.stageManifest(manifest, keyHex, "buyer-controlled-key-v1");
  // Renewal changes the entity's live expiry while the signed manifest preserves its original expiry floor.
  harness.store.getEntityMetadata = async () => ({ owner: storageOwner, expiresAt: 1_000_001n });
  let grantRequest: unknown;
  const recovered = await recoverAcceptedPackage({
    store: harness.store,
    keyGrants: {
      async resolveGrantedKey(request) {
        grantRequest = request;
        return keyHex;
      },
    },
    accepted: {
      jobId: manifest.jobId,
      taskId: manifest.taskId,
      producerEpoch: manifest.epoch,
      manifestDigest: staged.manifestDigest as `0x${string}`,
      manifestRef: staged.manifestRef,
      sequence: manifest.sequence,
      previousAcceptedHead: null,
      artifactManifestDigest: artifactManifestDigest(manifest) as `0x${string}`,
    },
    worker,
    expectedStorageOwner: storageOwner,
    supportedAdapters: [{ id: manifest.adapter.id, version: manifest.adapter.version, stateSchemaVersion: manifest.adapter.stateSchemaVersion }],
    retentionUntilBlock: 900_000n,
  });

  assert.equal(recovered.manifestRef, staged.manifestRef);
  assert.equal(recovered.manifestDigest, staged.manifestDigest);
  assert.equal(recovered.artifacts.length, 1);
  assert.deepEqual(Buffer.from(recovered.artifacts[0]!.bytes), plaintext);
  assert.deepEqual(grantRequest, {
    jobId: manifest.jobId,
    taskId: manifest.taskId,
    manifestDigest: staged.manifestDigest,
    keyId: "buyer-controlled-key-v1",
    worker,
  });

  await assert.rejects(
    recoverAcceptedPackage({
      store: harness.store,
      keyGrants: { async resolveGrantedKey() { return keyHex; } },
      accepted: {
        jobId: manifest.jobId,
        taskId: manifest.taskId,
        manifestDigest: staged.manifestDigest as `0x${string}`,
        manifestRef: staged.manifestRef,
        sequence: 1,
        previousAcceptedHead: null,
      },
      worker,
      expectedStorageOwner: storageOwner,
      supportedAdapters: [{ id: "unknown", version: "1", stateSchemaVersion: "1" }],
      retentionUntilBlock: 1_000_002n,
    }),
    /ARKIV_RETENTION_TOO_SHORT/,
  );
  await assert.rejects(
    recoverAcceptedPackage({
      store: harness.store,
      keyGrants: { async resolveGrantedKey() { return keyHex; } },
      accepted: {
        jobId: manifest.jobId,
        taskId: manifest.taskId,
        manifestDigest: staged.manifestDigest as `0x${string}`,
        manifestRef: staged.manifestRef,
        sequence: 1,
        previousAcceptedHead: null,
      },
      worker,
      expectedStorageOwner: storageOwner,
      supportedAdapters: [{ id: "unknown", version: "1", stateSchemaVersion: "1" }],
      retentionUntilBlock: 900_000n,
    }),
    /CHECKPOINT_ADAPTER_UNSUPPORTED/,
  );
});
