import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { getAddress, isHex } from "viem";
import { CheckpointKeyGrantStore } from "../../server/src/services/key-service/store.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [jobId, taskId, manifestDigest, workerAddress] = process.argv.slice(2);
if (!jobId || !taskId || !manifestDigest || !workerAddress) {
  throw new Error("Usage: npm run key-service:grant -- <jobId> <taskId> <manifestDigest> <workerAddress>");
}
if (!isHex(manifestDigest, { strict: true }) || manifestDigest.length !== 66) {
  throw new Error("manifestDigest must be a 32-byte 0x-prefixed hex value");
}
const localEnv = parse(await readFile(join(root, ".env"), "utf8"));
const serviceEnv = parse(await readFile(join(root, ".env.key-service"), "utf8"));
if (process.env.CHECKPOINT_ENCRYPTION_KEY
  && process.env.CHECKPOINT_ENCRYPTION_KEY !== localEnv.CHECKPOINT_ENCRYPTION_KEY) {
  throw new Error("CHECKPOINT_ENCRYPTION_KEY_ENV_CONFLICT");
}
if (process.env.CHECKPOINT_KEY_ID && process.env.CHECKPOINT_KEY_ID !== localEnv.CHECKPOINT_KEY_ID) {
  throw new Error("CHECKPOINT_KEY_ID_ENV_CONFLICT");
}
const keyHex = localEnv.CHECKPOINT_ENCRYPTION_KEY || "";
const keyId = localEnv.CHECKPOINT_KEY_ID || "";
if (!/^(0x)?[\da-f]{64}$/i.test(keyHex)) throw new Error("CHECKPOINT_ENCRYPTION_KEY is missing or invalid in the buyer environment");
if (!keyId) throw new Error("CHECKPOINT_KEY_ID is missing in the buyer environment");
const databasePath = resolve(root, serviceEnv.CHECKPOINT_KEY_SERVICE_DATABASE_PATH || ".baton-data/checkpoint-key-service.sqlite");
const store = new CheckpointKeyGrantStore(databasePath, serviceEnv.CHECKPOINT_KEY_SERVICE_STORAGE_KEY || "");
try {
  store.grantKey({
    jobId,
    taskId,
    manifestDigest: manifestDigest.toLowerCase(),
    keyId,
    worker: getAddress(workerAddress),
  }, keyHex);
} finally {
  store.close();
}
process.stdout.write(JSON.stringify({ result: "grant-stored", jobId, taskId, manifestDigest: manifestDigest.toLowerCase(), keyId, worker: getAddress(workerAddress) }) + "\n");
