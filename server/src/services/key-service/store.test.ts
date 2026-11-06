import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { batchOneCheckpoint } from "../../../packages/checkpoint/src/fixtures.js";
import { decryptManifest, encryptManifest, encryptedEnvelopeDigest } from "../../../packages/checkpoint/src/index.js";
import { HttpCheckpointKeyGrantResolver } from "../../../packages/storage/src/httpKeyGrantResolver.js";
import { generateCheckpointKeyRecipientPair } from "../../../packages/storage/src/keyGrantCrypto.js";
import type { CheckpointKeyGrantRequest } from "../../../packages/storage/src/recovery.js";
import { CheckpointKeyGrantStore, KeyServiceError } from "./store.js";

const workerA = ("0x" + "11".repeat(20)) as Address;
const workerB = ("0x" + "22".repeat(20)) as Address;
const workerAToken = "worker-a-test-token-" + "a".repeat(44);
const workerBToken = "worker-b-test-token-" + "b".repeat(44);
const checkpointKey = "0x" + "55".repeat(32);
const storageKey = "0x" + "99".repeat(32);

test("authorized B decrypts only its exact checkpoint key; unauthorized worker requests are denied", async () => {
  const store = new CheckpointKeyGrantStore(":memory:", storageKey);
  const pairA = generateCheckpointKeyRecipientPair();
  const pairB = generateCheckpointKeyRecipientPair();
  try {
    store.replaceWorkerToken(workerA, workerAToken, pairA.publicKey);
    store.replaceWorkerToken(workerB, workerBToken, pairB.publicKey);

    const manifest = { ...batchOneCheckpoint, jobId: "key-service-job-7", taskId: "key-service-task-7" };
    const envelope = encryptManifest(manifest, checkpointKey, "buyer-key-7");
    const request: CheckpointKeyGrantRequest = {
      jobId: manifest.jobId,
      taskId: manifest.taskId,
      manifestDigest: encryptedEnvelopeDigest(envelope) as `0x${string}`,
      keyId: envelope.keyId,
      worker: workerB,
    };
    store.grantKey(request, checkpointKey);

    const serviceFetch: typeof fetch = async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      try {
        const grant = store.resolve(token, JSON.parse(String(init?.body)) as CheckpointKeyGrantRequest);
        return new Response(JSON.stringify(grant), { status: 200 });
      } catch (error) {
        if (error instanceof KeyServiceError) {
          return new Response(JSON.stringify({ error: "KEY_GRANT_DENIED" }), {
            status: error.code === "UNAUTHORIZED" ? 401 : 403,
          });
        }
        return new Response(JSON.stringify({ error: "KEY_GRANT_REQUEST_INVALID" }), { status: 400 });
      }
    };

    const bResolver = new HttpCheckpointKeyGrantResolver(
      "https://buyer-key-service.example.test/v1/resolve",
      workerBToken,
      pairB.privateKey,
      serviceFetch,
    );
    const recoveredKey = await bResolver.resolveGrantedKey(request);
    assert.equal(recoveredKey, checkpointKey);
    assert.deepEqual(decryptManifest(envelope, recoveredKey), manifest);

    const aResolver = new HttpCheckpointKeyGrantResolver(
      "https://buyer-key-service.example.test/v1/resolve",
      workerAToken,
      pairA.privateKey,
      serviceFetch,
    );
    await assert.rejects(aResolver.resolveGrantedKey({ ...request, worker: workerA }), /KEY_GRANT_DENIED/);
    await assert.rejects(bResolver.resolveGrantedKey({ ...request, worker: workerA }), /KEY_GRANT_DENIED/);
    await assert.rejects(
      bResolver.resolveGrantedKey({ ...request, manifestDigest: ("0x" + "aa".repeat(32)) as `0x${string}` }),
      /KEY_GRANT_DENIED/,
    );
    await assert.rejects(
      bResolver.resolveGrantedKey({ ...request, keyId: "different-key" }),
      /KEY_GRANT_DENIED/,
    );
  } finally {
    store.close();
  }
});

test("unregistered bearer tokens and worker-subject mismatches fail closed", () => {
  const store = new CheckpointKeyGrantStore(":memory:", storageKey);
  const pairB = generateCheckpointKeyRecipientPair();
  try {
    store.replaceWorkerToken(workerB, workerBToken, pairB.publicKey);
    const request: CheckpointKeyGrantRequest = {
      jobId: "job",
      taskId: "task",
      manifestDigest: ("0x" + "12".repeat(32)) as `0x${string}`,
      keyId: "key-v1",
      worker: workerB,
    };
    assert.throws(() => store.resolve("unknown-token-" + "x".repeat(44), request), /UNAUTHORIZED/);
    assert.throws(() => store.resolve(workerBToken, { ...request, worker: workerA }), /WORKER_SUBJECT_MISMATCH/);
  } finally {
    store.close();
  }
});
