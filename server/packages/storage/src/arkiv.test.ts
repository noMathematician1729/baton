import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Hex } from "viem";
import { artifactManifestDigest, MAX_PLAINTEXT_CHUNK_BYTES } from "../../checkpoint/src/index.js";
import { batchOneCheckpoint } from "../../checkpoint/src/fixtures.js";
import { ArkivContentStore } from "./arkiv.js";
import { recoverAcceptedPackage } from "./recovery.js";

const storageOwner = ("0x" + "11".repeat(20)) as `0x${string}`;

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
      retentionUntilBlock: 1_000_001n,
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
