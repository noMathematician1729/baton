import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { getAddress, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayActionDomain, gatewayActionMessage, GATEWAY_ACTION_TYPES } from "../../server/src/chain/gatewayAction.ts";
import { SepoliaAuthorityReader } from "../../server/src/chain/sepoliaAuthority.ts";
import { deserialise } from "../../server/src/protocol/v1.ts";
import { OperationLedger } from "../../server/src/services/ledger/operationLedger.ts";
import { grantAcceptedCheckpointKey } from "../../server/src/services/key-service/buyerGrant.ts";
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
for (const name of ["BATON_BUYER_EVM_PRIVATE_KEY", "SEPOLIA_DEPLOYER_PRIVATE_KEY"]) {
  if (process.env[name] && localEnv[name] && process.env[name] !== localEnv[name]) {
    throw new Error("BUYER_SIGNER_ENV_CONFLICT");
  }
}
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
const worker = getAddress(workerAddress);
const serverRoot = resolve(root, "server");
const dataDirectory = localEnv.BATON_DATA_DIR || ".baton-data";
const jobsPath = resolve(isAbsolute(dataDirectory) ? dataDirectory : join(serverRoot, dataDirectory), "jobs.json");
const jobFile = JSON.parse(await readFile(jobsPath, "utf8"));
const job = deserialise(jobFile.jobs?.[jobId]);
if (!job || job.terms?.jobId !== jobId || job.terms?.task?.taskId !== taskId) {
  throw new Error("KEY_GRANT_JOB_NOT_FOUND");
}
if (job.task.acceptedHead.sequence < 1
  || !job.task.acceptedHead.manifestRef
  || job.task.acceptedHead.manifestDigest.toLowerCase() !== manifestDigest.toLowerCase()) {
  throw new Error("KEY_GRANT_CHECKPOINT_NOT_ACCEPTED");
}
const buyerKeyText = process.env.BATON_BUYER_EVM_PRIVATE_KEY || localEnv.BATON_BUYER_EVM_PRIVATE_KEY
  || process.env.SEPOLIA_DEPLOYER_PRIVATE_KEY || localEnv.SEPOLIA_DEPLOYER_PRIVATE_KEY || "";
if (!buyerKeyText) throw new Error("BATON_BUYER_EVM_PRIVATE_KEY is required for buyer-signed grants");
const buyerKey = buyerKeyText.startsWith("0x") ? buyerKeyText : `0x${buyerKeyText}`;
if (!/^0x[\da-f]{64}$/i.test(buyerKey)) throw new Error("BATON_BUYER_EVM_PRIVATE_KEY_INVALID");
const buyerAccount = privateKeyToAccount(buyerKey);
if (buyerAccount.address.toLowerCase() !== job.terms.buyer.toLowerCase()) {
  throw new Error("BUYER_SIGNER_DOES_NOT_MATCH_JOB");
}
const rpcUrl = process.env.SEPOLIA_RPC_URL || localEnv.SEPOLIA_RPC_URL || "";
const rpcBackupUrls = (process.env.SEPOLIA_RPC_BACKUP_URLS || localEnv.SEPOLIA_RPC_BACKUP_URLS || "")
  .split(",").map((url) => url.trim()).filter(Boolean);
const escrowAddress = process.env.BATON_ESCROW_ADDRESS || localEnv.BATON_ESCROW_ADDRESS || "";
const adapterAddress = process.env.BATON_AUTHORITY_ADAPTER_ADDRESS || localEnv.BATON_AUTHORITY_ADAPTER_ADDRESS || "";
const chainId = Number(process.env.SEPOLIA_CHAIN_ID || localEnv.SEPOLIA_CHAIN_ID || "11155111");
if (!rpcUrl || !escrowAddress || !adapterAddress || chainId !== 11155111) {
  throw new Error("SEPOLIA_AUTHORITY_CONFIG_INCOMPLETE");
}
const authority = new SepoliaAuthorityReader({
  rpcUrl,
  backupRpcUrls,
  escrowAddress,
  adapterAddress,
  confirmationBlocks: Number(process.env.CONFIRMATION_BLOCKS || localEnv.CONFIRMATION_BLOCKS || "2"),
});
await authority.assertSnapshotCurrent(job);

const nonce = `0x${randomBytes(32).toString("hex")}`;
const expiry = Math.floor(Date.now() / 1000) + 120;
const payload = {
  jobId,
  taskId,
  manifestDigest: manifestDigest.toLowerCase(),
  keyId,
  worker: worker.toLowerCase(),
};
const message = gatewayActionMessage({
  action: "GRANT_CHECKPOINT_KEY",
  job,
  actor: job.terms.buyer,
  epoch: job.task.epoch,
  payload,
  nonce,
  expiry,
});
const authSignature = await buyerAccount.signTypedData({
  domain: gatewayActionDomain(chainId, escrowAddress),
  types: GATEWAY_ACTION_TYPES,
  primaryType: "GatewayAction",
  message,
});
const databasePath = resolve(root, serviceEnv.CHECKPOINT_KEY_SERVICE_DATABASE_PATH || ".baton-data/checkpoint-key-service.sqlite");
const store = new CheckpointKeyGrantStore(databasePath, serviceEnv.CHECKPOINT_KEY_SERVICE_STORAGE_KEY || "");
const configuredLedgerPath = localEnv.PAYMENT_LEDGER_PATH || "./data/payment-ledger.sqlite";
const ledgerPath = isAbsolute(configuredLedgerPath) ? configuredLedgerPath : resolve(serverRoot, configuredLedgerPath);
let ledger;
try {
  ledger = new OperationLedger(ledgerPath);
  await grantAcceptedCheckpointKey({
    job,
    request: { jobId, taskId, manifestDigest: manifestDigest.toLowerCase(), keyId, worker },
    keyHex,
    keyId,
    authorizationBody: { authNonce: nonce, authExpiry: expiry, authSignature },
    chainId,
    verifyingContract: escrowAddress,
    nonceStore: ledger,
    writer: store,
  });
} finally {
  ledger?.close();
  store.close();
}
process.stdout.write(JSON.stringify({
  result: "grant-stored",
  jobId,
  taskId,
  manifestDigest: manifestDigest.toLowerCase(),
  keyId,
  worker,
  buyer: buyerAccount.address,
  confirmedBlock: authority.lastConfirmedRead?.blockNumber.toString(),
}) + "\n");
