import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { getAddress } from "viem";
import {
  CheckpointKeyGrantStore,
  generateWorkerAccessToken,
} from "../../server/src/services/key-service/store.ts";
import { generateCheckpointKeyRecipientPair } from "../../server/packages/storage/src/keyGrantCrypto.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rootEnv = await readEnv(join(root, ".env"));
const serviceEnvPath = join(root, ".env.key-service");
const serviceEnv = await readEnv(serviceEnvPath);
const workerEntries = [
  { suffix: "worker-a", address: rootEnv.WORKER_A_ADDRESS },
  { suffix: "worker-b", address: rootEnv.WORKER_B_ADDRESS },
];
for (const worker of workerEntries) {
  if (!worker.address) throw new Error(`Missing ${worker.suffix.toUpperCase().replace("-", "_")}_ADDRESS in root .env`);
  worker.address = getAddress(worker.address);
}

const storageKey = isSecretHex(serviceEnv.CHECKPOINT_KEY_SERVICE_STORAGE_KEY)
  ? serviceEnv.CHECKPOINT_KEY_SERVICE_STORAGE_KEY
  : "0x" + randomBytes(32).toString("hex");
const databasePath = serviceEnv.CHECKPOINT_KEY_SERVICE_DATABASE_PATH
  || ".baton-data/checkpoint-key-service.sqlite";
const host = serviceEnv.CHECKPOINT_KEY_SERVICE_HOST || "127.0.0.1";
const port = serviceEnv.CHECKPOINT_KEY_SERVICE_PORT || "4411";
const sharedUrl = serviceEnv.CHECKPOINT_KEY_SERVICE_URL
  || rootEnv.CHECKPOINT_KEY_SERVICE_URL
  || "http://127.0.0.1:4411/v1/resolve";

await writeEnvValues(serviceEnvPath, {
  CHECKPOINT_KEY_SERVICE_HOST: host,
  CHECKPOINT_KEY_SERVICE_PORT: port,
  CHECKPOINT_KEY_SERVICE_DATABASE_PATH: databasePath,
  CHECKPOINT_KEY_SERVICE_STORAGE_KEY: storageKey,
  CHECKPOINT_KEY_SERVICE_URL: sharedUrl,
});

const serviceDbPath = resolve(root, databasePath);
const store = new CheckpointKeyGrantStore(serviceDbPath, storageKey);
try {
  for (const worker of workerEntries) {
    const filePath = join(root, `.env.${worker.suffix}`);
    const current = await readEnv(filePath);
    const token = /^[A-Za-z0-9_-]{40,}$/.test(current.CHECKPOINT_KEY_SERVICE_TOKEN ?? "")
      ? current.CHECKPOINT_KEY_SERVICE_TOKEN
      : generateWorkerAccessToken();
    const keyPair = loadRecipientPair(current.CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY)
      ?? generateCheckpointKeyRecipientPair();
    store.replaceWorkerToken(worker.address, token, keyPair.publicKey);
    await writeEnvValues(filePath, {
      WORKER_ADDRESS: worker.address,
      CHECKPOINT_KEY_SERVICE_URL: sharedUrl,
      CHECKPOINT_KEY_SERVICE_TOKEN: token,
      CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY: keyPair.privateKey,
    });
  }
} finally {
  store.close();
}

process.stdout.write(JSON.stringify({
  result: "provisioned",
  files: [".env.key-service", ".env.worker-a", ".env.worker-b"],
  serviceUrlMode: sharedUrl.startsWith("https:") ? "https" : "local-only-http",
  tokensPrinted: false,
  envFileMode: "0600",
}) + "\n");

async function readEnv(path) {
  try {
    return parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeEnvValues(path, updates) {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const lines = content ? content.split(/\r?\n/) : [];
  for (const [name, value] of Object.entries(updates)) {
    const prefix = `${name}=`;
    const index = lines.findIndex((line) => line.startsWith(prefix));
    if (index >= 0) lines[index] = prefix + value;
    else lines.push(prefix + value);
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  const temporary = `${path}.tmp`;
  await writeFile(temporary, lines.join("\n") + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function isSecretHex(value) {
  return typeof value === "string" && /^(0x)?[\da-f]{64}$/i.test(value);
}

function loadRecipientPair(privateKeyText) {
  if (!privateKeyText) return undefined;
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(privateKeyText, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "x25519") return undefined;
    const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64url");
    return { privateKey: privateKeyText, publicKey };
  } catch {
    return undefined;
  }
}
