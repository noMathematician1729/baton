import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { generateCheckpointKeyRecipientPair, encryptCheckpointKeyForWorker } from "./keyGrantCrypto.js";
import { HttpCheckpointKeyGrantResolver } from "./httpKeyGrantResolver.js";

const request = {
  jobId: "job-1",
  taskId: "task-1",
  manifestDigest: ("0x" + "a".repeat(64)) as `0x${string}`,
  keyId: "buyer-key-1",
  worker: ("0x" + "b".repeat(40)) as `0x${string}`,
};
const keyHex = "0x" + "c".repeat(64);
const recipient = generateCheckpointKeyRecipientPair();

test("key grant resolver sends a scoped authenticated request and checks every returned binding", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const resolver = new HttpCheckpointKeyGrantResolver(
    "https://keys.example.test/v1/resolve",
    "private-test-token",
    recipient.privateKey,
    async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({
        ...request,
        encryptedKey: encryptCheckpointKeyForWorker(keyHex, recipient.publicKey, request),
      }), { status: 200 });
    },
  );

  assert.equal(await resolver.resolveGrantedKey(request), keyHex);
  assert.equal(capturedUrl, "https://keys.example.test/v1/resolve");
  assert.equal(new Headers(capturedInit?.headers).get("authorization"), "Bearer private-test-token");
  assert.equal(capturedInit?.redirect, "error");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), request);

  const mismatched = new HttpCheckpointKeyGrantResolver(
    "https://keys.example.test/v1/resolve",
    "private-test-token",
    recipient.privateKey,
    async () => new Response(JSON.stringify({
      ...request,
      taskId: "other-task",
      encryptedKey: encryptCheckpointKeyForWorker(keyHex, recipient.publicKey, request),
    }), { status: 200 }),
  );
  await assert.rejects(mismatched.resolveGrantedKey(request), /CHECKPOINT_KEY_GRANT_BINDING_MISMATCH/);

  const tampered = new HttpCheckpointKeyGrantResolver(
    "https://keys.example.test/v1/resolve",
    "private-test-token",
    recipient.privateKey,
    async () => {
      const encryptedKey = encryptCheckpointKeyForWorker(keyHex, recipient.publicKey, request);
      encryptedKey.ciphertext = randomBytes(32).toString("base64url");
      return new Response(JSON.stringify({ ...request, encryptedKey }), { status: 200 });
    },
  );
  await assert.rejects(tampered.resolveGrantedKey(request), /CHECKPOINT_KEY_GRANT_DECRYPTION_FAILED/);
});

test("key grant resolver requires TLS and a private bearer token", () => {
  assert.throws(() => new HttpCheckpointKeyGrantResolver("http://keys.example.test/resolve", "token", recipient.privateKey), /TLS_REQUIRED/);
  assert.throws(() => new HttpCheckpointKeyGrantResolver("https://keys.example.test/resolve", " ", recipient.privateKey), /AUTH_REQUIRED/);
  assert.throws(() => new HttpCheckpointKeyGrantResolver("https://keys.example.test/resolve", "token", " "), /RECIPIENT_KEY_REQUIRED/);
});
