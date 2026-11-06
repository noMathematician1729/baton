import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { ArtifactReference } from "../../packages/checkpoint/src/index.js";
import { ArkivPaidOutputStore } from "./arkivPaidOutput.js";

const bytes = Buffer.from("private purchased result bytes");
const digest = sha256(bytes);
const owner = ("0x" + "3".repeat(40)) as `0x${string}`;
const reference: ArtifactReference = {
  artifactId: "paid-output:op-1",
  mediaType: "application/octet-stream",
  byteLength: bytes.byteLength,
  contentDigest: digest,
  encrypted: true,
  chunks: [{
    index: 0,
    entityKey: "0x" + "1".repeat(64),
    ciphertextDigest: "0x" + "2".repeat(64),
    ciphertextBytes: 64,
    expiresAt: "999999999",
    owner,
  }],
};

test("Arkiv paid-output store records an encrypted artifact pointer and reads back matching bytes", async () => {
  let writeInput: unknown;
  let readInput: unknown;
  const outputStore = new ArkivPaidOutputStore({
    async stageArtifact(input) { writeInput = input; return reference; },
    async readArtifact(input) { readInput = input; return Uint8Array.from(bytes); },
    async getEntityMetadata() { return { owner, expiresAt: 999999999n }; },
  } as never, {
    async resolve(input) {
      assert.deepEqual({ jobId: input.jobId, taskId: input.taskId, operationId: input.operationId }, {
        jobId: "job-1", taskId: "task-1", operationId: "op-1",
      });
      return "0x" + "4".repeat(64);
    },
  }, owner);

  const stored = await outputStore.put({ jobId: "job-1", taskId: "task-1", operationId: "op-1", bytes });
  assert.equal(stored.outputDigest, digest);
  assert.equal(stored.outputRef.startsWith("arkiv://paid-output/"), true);
  assert.equal(stored.outputRef.includes(bytes.toString()), false);
  assert.equal(Buffer.compare(Buffer.from(await outputStore.get({
    jobId: "job-1", taskId: "task-1", operationId: "op-1", outputRef: stored.outputRef, expectedDigest: digest,
  })), bytes), 0);
  assert.equal((writeInput as { artifactId: string }).artifactId, "paid-output:op-1");
  assert.equal((writeInput as { keyHex: string }).keyHex, "0x" + "4".repeat(64));
  assert.equal((readInput as { reference: ArtifactReference }).reference.artifactId, reference.artifactId);
});

test("Arkiv paid-output pointer is bound to its operation and digest", async () => {
  const outputStore = new ArkivPaidOutputStore({
    async stageArtifact() { return reference; },
    async readArtifact() { return Uint8Array.from(bytes); },
    async getEntityMetadata() { return { owner, expiresAt: 999999999n }; },
  } as never, { async resolve() { return "0x" + "4".repeat(64); } }, owner);
  const stored = await outputStore.put({ jobId: "job-1", taskId: "task-1", operationId: "op-1", bytes });
  await assert.rejects(outputStore.get({
    jobId: "job-1", taskId: "task-1", operationId: "op-other", outputRef: stored.outputRef, expectedDigest: digest,
  }), /PAID_OUTPUT_REFERENCE_BINDING_MISMATCH/);
  await assert.rejects(outputStore.get({
    jobId: "job-1", taskId: "task-1", operationId: "op-1", outputRef: stored.outputRef, expectedDigest: "0x" + "f".repeat(64),
  }), /PAID_OUTPUT_REFERENCE_DIGEST_MISMATCH/);
});

function sha256(value: Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}
