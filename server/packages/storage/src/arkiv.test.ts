import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Hex } from "viem";
import { MAX_PLAINTEXT_CHUNK_BYTES } from "../../checkpoint/src/index.js";
import { ArkivContentStore } from "./arkiv.js";

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
    return { entityKey, txHash, ciphertextDigest, ciphertextBytes: bytes.byteLength, expiresAt: 1n };
  };

  store.readExact = async (entityKey, expectedDigest) => {
    const payload = entities.get(entityKey);
    if (!payload) throw new Error("Arkiv entity not found");
    const digest = "0x" + createHash("sha256").update(payload).digest("hex");
    if (digest !== expectedDigest) throw new Error("Arkiv content digest mismatch");
    return Uint8Array.from(payload);
  };

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
