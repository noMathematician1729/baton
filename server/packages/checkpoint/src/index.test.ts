import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptChunk, decryptManifest, encryptChunk, encryptManifest } from "./crypto.js";
import { batchOneCheckpoint } from "./fixtures.js";

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("checkpoint encryption round-trips with authenticated identity", () => {
  const encrypted = encryptManifest(batchOneCheckpoint, key, "test-key");
  assert.deepEqual(decryptManifest(encrypted, key), batchOneCheckpoint);
});

test("checkpoint encryption rejects a changed ciphertext", () => {
  const encrypted = encryptManifest(batchOneCheckpoint, key, "test-key");
  assert.throws(() => decryptManifest({ ...encrypted, ciphertext: encrypted.ciphertext + "x" }, key));
});

test("checkpoint encryption rejects a wrong key", () => {
  const encrypted = encryptManifest(batchOneCheckpoint, key, "test-key");
  assert.throws(() => decryptManifest(encrypted, "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"));
});

test("artifact chunks encrypt and authenticate their job-scoped context", () => {
  const content = Buffer.from("encrypted fixture contents");
  const encrypted = encryptChunk(content, key, "job-1:task-2:artifact-3:chunk-0");
  assert.deepEqual(
    decryptChunk(encrypted.bytes, encrypted.digest, key, "job-1:task-2:artifact-3:chunk-0"),
    content,
  );
  assert.throws(() => decryptChunk(encrypted.bytes, encrypted.digest, key, "job-1:task-2:artifact-4:chunk-0"));
});
