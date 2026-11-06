import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { HttpCheckpointKeyGrantResolver } from "../../server/packages/storage/src/httpKeyGrantResolver.ts";
import { CheckpointKeyGrantStore, KeyServiceError } from "../../server/src/services/key-service/store.ts";
import { batchOneCheckpoint } from "../../server/packages/checkpoint/src/fixtures.ts";
import { decryptManifest, encryptManifest, encryptedEnvelopeDigest } from "../../server/packages/checkpoint/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const buyerEnv = await readEnv(join(root, ".env"));
const serviceEnv = await readEnv(join(root, ".env.key-service"));
const workerAEnv = await readEnv(join(root, ".env.worker-a"));
const workerBEnv = await readEnv(join(root, ".env.worker-b"));
const workerA = buyerEnv.WORKER_A_ADDRESS;
const workerB = buyerEnv.WORKER_B_ADDRESS;
const checkpointKey = buyerEnv.CHECKPOINT_ENCRYPTION_KEY;
const keyId = buyerEnv.CHECKPOINT_KEY_ID;
if (!workerA || !workerB || !isKey(checkpointKey) || !keyId) {
  throw new Error("Buyer checkpoint/worker configuration is incomplete");
}
if (!workerAEnv.CHECKPOINT_KEY_SERVICE_TOKEN || !workerBEnv.CHECKPOINT_KEY_SERVICE_TOKEN
  || !workerAEnv.CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY
  || !workerBEnv.CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY) {
  throw new Error("Worker key-service credentials have not been provisioned");
}

const store = new CheckpointKeyGrantStore(":memory:", serviceEnv.CHECKPOINT_KEY_SERVICE_STORAGE_KEY || "");
try {
  store.replaceWorkerToken(workerA, workerAEnv.CHECKPOINT_KEY_SERVICE_TOKEN, recipientPublicKey(workerAEnv.CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY));
  store.replaceWorkerToken(workerB, workerBEnv.CHECKPOINT_KEY_SERVICE_TOKEN, recipientPublicKey(workerBEnv.CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY));
  const manifest = {
    ...batchOneCheckpoint,
    jobId: "key-service-smoke-job",
    taskId: "key-service-smoke-task",
  };
  const envelope = encryptManifest(manifest, checkpointKey, keyId);
  const request = {
    jobId: manifest.jobId,
    taskId: manifest.taskId,
    manifestDigest: encryptedEnvelopeDigest(envelope),
    keyId,
    worker: workerB,
  };
  store.grantKey(request, checkpointKey);

  const serviceFetch = async (_input, init) => {
    const header = new Headers(init?.headers).get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    try {
      return new Response(JSON.stringify(store.resolve(token, JSON.parse(String(init?.body)))), { status: 200 });
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
    workerBEnv.CHECKPOINT_KEY_SERVICE_URL,
    workerBEnv.CHECKPOINT_KEY_SERVICE_TOKEN,
    workerBEnv.CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY,
    serviceFetch,
  );
  const keyForB = await bResolver.resolveGrantedKey(request);
  const recovered = decryptManifest(envelope, keyForB);
  if (recovered.jobId !== manifest.jobId || recovered.taskId !== manifest.taskId) {
    throw new Error("Worker B recovered the wrong checkpoint");
  }

  const aResolver = new HttpCheckpointKeyGrantResolver(
    workerAEnv.CHECKPOINT_KEY_SERVICE_URL,
    workerAEnv.CHECKPOINT_KEY_SERVICE_TOKEN,
    workerAEnv.CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY,
    serviceFetch,
  );
  let unauthorizedDenied = false;
  try {
    await aResolver.resolveGrantedKey({ ...request, worker: workerA });
  } catch (error) {
    unauthorizedDenied = error instanceof Error && error.message === "CHECKPOINT_KEY_GRANT_DENIED";
  }
  if (!unauthorizedDenied) throw new Error("Worker A was not denied the B-scoped checkpoint key");

  let impersonationDenied = false;
  try {
    await bResolver.resolveGrantedKey({ ...request, worker: workerA });
  } catch (error) {
    impersonationDenied = error instanceof Error && error.message === "CHECKPOINT_KEY_GRANT_DENIED";
  }
  if (!impersonationDenied) throw new Error("Worker B's token accepted a different worker identity");

  process.stdout.write(JSON.stringify({
    result: "verified",
    workerBDecryptsExactFixtureCheckpoint: true,
    workerADenied: true,
    workerIdentitySpoofDenied: true,
    secretValuesPrinted: false,
  }) + "\n");
} finally {
  store.close();
}

async function readEnv(path) {
  try {
    return parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function isKey(value) {
  return typeof value === "string" && /^(0x)?[\da-f]{64}$/i.test(value);
}

function recipientPublicKey(privateKeyText) {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyText, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "x25519") throw new Error("Worker recipient key has the wrong type");
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64url");
}
