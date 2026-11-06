import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotEnv } from "dotenv";
import { getAddress, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArkivContentStore } from "../../../packages/storage/src/arkiv.js";
import { HttpCheckpointKeyGrantResolver } from "../../../packages/storage/src/httpKeyGrantResolver.js";
import { SepoliaAuthorityReader } from "../../../src/chain/sepoliaAuthority.js";
import { fetchJobSnapshotFromGateway, recoverAndAcknowledgeAcceptedCheckpoint } from "./acceptedCheckpointRecovery.js";
import { recoverReusablePaidOperation } from "./takeoverPolicyClient.js";
import { runLocalDemo } from "./localDemo.js";
import { discoverConfiguredMcpTools, probeConfiguredMcpTool } from "../../../services/tools/probe.js";
import { applyWorkerEnvironment } from "./workerEnvironment.js";

loadWorkerEnvironment();
const [command, ...args] = process.argv.slice(2);

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "WORKER_COMMAND_FAILED");
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (command === "demo-local") {
    const result = runLocalDemo();
    console.log("Local checkpoint handoff passed.");
    console.log("A completed: batch-1 (sum " + result.stateA.completed[0]?.sum + ")");
    console.log("B recovered the AES-256-GCM checkpoint and completed: batch-2, batch-3");
    console.log("Final batch outputs: " + result.finalState.completed.map((batch) => batch.batchId + "=" + batch.outputDigest).join(", "));
    console.log("Quantitative state continued with posterior mean " + result.posteriorMean.toFixed(2));
    console.log("Encrypted envelope bytes: " + result.encryptedEnvelopeBytes);
    console.log("Local fixture only: no Arkiv write, wallet, payment, or chain transaction was used.");
    return;
  }
  if (command === "recover-accepted") {
    const jobId = args[0];
    if (!jobId) fail("Usage: baton-worker recover-accepted <jobId>");
    await recoverAccepted(jobId);
    return;
  }
  if (command === "recover-paid-output") {
    const jobId = args[0];
    const operationId = args[1];
    if (!jobId || !operationId) fail("Usage: baton-worker recover-paid-output <jobId> <operationId>");
    await recoverPaidOutput(jobId, operationId);
    return;
  }
  if (command === "probe-tool") {
    await probeBTool();
    return;
  }
  if (command === "list-tools") {
    const result = await discoverConfiguredMcpTools({
      serverUrl: required("MCP_SERVER_URL"),
      bearerToken: required("MCP_API_KEY"),
      timeoutMs: positiveInteger("MCP_PROBE_TIMEOUT_MS", 15_000),
    });
    console.log(JSON.stringify(result));
    return;
  }
  fail("Usage: baton-worker <demo-local|recover-accepted <jobId>|recover-paid-output <jobId> <operationId>|list-tools|probe-tool>");
}

async function probeBTool(): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(required("MCP_PROBE_INPUT_JSON"));
  } catch {
    throw new Error("WORKER_CONFIG_INVALID:MCP_PROBE_INPUT_JSON");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("WORKER_CONFIG_INVALID:MCP_PROBE_INPUT_JSON");
  }
  const result = await probeConfiguredMcpTool({
    serverUrl: required("MCP_SERVER_URL"),
    bearerToken: required("MCP_API_KEY"),
    expectedServerId: required("MCP_EXPECTED_SERVER_ID"),
    toolName: required("MCP_PROBE_TOOL_NAME"),
    schemaVersion: required("MCP_PROBE_SCHEMA_VERSION"),
    schemaDigest: required("MCP_PROBE_SCHEMA_DIGEST"),
    input: input as Record<string, unknown>,
    expectedOutputDigest: required("MCP_PROBE_EXPECTED_OUTPUT_DIGEST"),
    timeoutMs: positiveInteger("MCP_PROBE_TIMEOUT_MS", 15_000),
  });
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}

async function recoverAccepted(jobId: string): Promise<void> {
  const apiUrl = optional("BATON_API_URL") ?? `http://127.0.0.1:${process.env.SERVER_PORT ?? "4000"}`;
  const chainId = Number(process.env.SEPOLIA_CHAIN_ID ?? "11155111");
  if (chainId !== 11155111) throw new Error("WORKER_CHAIN_MUST_BE_SEPOLIA");
  const escrowAddress = address("BATON_ESCROW_ADDRESS");
  const adapterAddress = address("BATON_AUTHORITY_ADAPTER_ADDRESS");
  const configuredWorker = address("WORKER_ADDRESS", "WORKER_B_ADDRESS");
  const workerKey = privateKey("WORKER_EVM_PRIVATE_KEY", "WORKER_B_EVM_PRIVATE_KEY");
  const account = privateKeyToAccount(workerKey);
  if (account.address.toLowerCase() !== configuredWorker.toLowerCase()) {
    throw new Error("WORKER_SIGNER_ADDRESS_MISMATCH");
  }

  const rpcUrl = required("SEPOLIA_RPC_URL");
  const backupRpcUrls = (process.env.SEPOLIA_RPC_BACKUP_URLS ?? "")
    .split(",").map((url) => url.trim()).filter(Boolean);
  const authority = new SepoliaAuthorityReader({
    rpcUrl,
    backupRpcUrls,
    escrowAddress,
    adapterAddress,
    confirmationBlocks: positiveInteger("CONFIRMATION_BLOCKS", 2),
  });

  const store = new ArkivContentStore({
    accessKey: required("ARKIV_ACCESS_KEY"),
    rpcUrl: optional("ARKIV_RPC_URL", "ARKIV_RPC_URL_B"),
    permissionlessExtension: false,
  });
  const keyGrants = new HttpCheckpointKeyGrantResolver(
    required("CHECKPOINT_KEY_SERVICE_URL"),
    required("CHECKPOINT_KEY_SERVICE_TOKEN"),
    required("CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY"),
  );
  const job = await fetchJobSnapshotFromGateway({ apiUrl, jobId });
  const result = await recoverAndAcknowledgeAcceptedCheckpoint({
    apiUrl,
    chainId,
    escrowAddress,
    job,
    account,
    authority,
    store,
    keyGrants,
    expectedStorageOwner: address("ARKIV_STORAGE_OWNER_ADDRESS"),
  });

  console.log("Accepted checkpoint recovered and imported.");
  console.log(`Job: ${jobId}`);
  console.log(`Confirmed head: ${result.acceptedHead}`);
  console.log(`Adapter: ${result.importedState.adapterId}`);
  console.log("Exact-head acknowledgement submitted to the gateway.");
}

async function recoverPaidOutput(jobId: string, operationId: string): Promise<void> {
  const apiUrl = optional("BATON_API_URL") ?? `http://127.0.0.1:${process.env.SERVER_PORT ?? "4000"}`;
  const chainId = Number(process.env.SEPOLIA_CHAIN_ID ?? "11155111");
  if (chainId !== 11155111) throw new Error("WORKER_CHAIN_MUST_BE_SEPOLIA");
  const escrowAddress = address("BATON_ESCROW_ADDRESS");
  const configuredWorker = address("WORKER_ADDRESS", "WORKER_B_ADDRESS");
  const account = privateKeyToAccount(privateKey("WORKER_EVM_PRIVATE_KEY", "WORKER_B_EVM_PRIVATE_KEY"));
  if (account.address.toLowerCase() !== configuredWorker.toLowerCase()) {
    throw new Error("WORKER_SIGNER_ADDRESS_MISMATCH");
  }
  const job = await fetchJobSnapshotFromGateway({ apiUrl, jobId });
  const recovered = await recoverReusablePaidOperation({
    apiUrl,
    escrowAddress,
    chainId,
    job,
    operationId,
    account,
  });
  process.stderr.write(JSON.stringify({
    operationId: recovered.operation.operationId,
    producer: recovered.operation.worker,
    producerEpoch: recovered.operation.epoch,
    outputDigest: recovered.operation.outputDigest,
    byteLength: recovered.bytes.byteLength,
  }) + "\n");
  await writeBinaryOutput(recovered.bytes);
}

function writeBinaryOutput(bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(Buffer.from(bytes), (error) => error ? reject(error) : resolve());
  });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`WORKER_CONFIG_REQUIRED:${name}`);
  return value;
}

function optional(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function address(name: string, fallbackName?: string): `0x${string}` {
  return configuredAddress(name, fallbackName);
}

function configuredAddress(name: string, fallbackName?: string): `0x${string}` {
  try {
    return getAddress(optional(name, ...(fallbackName ? [fallbackName] : [])) ?? required(name));
  } catch {
    throw new Error(`WORKER_CONFIG_INVALID:${name}`);
  }
}

function privateKey(...names: string[]): Hex {
  const value = optional(...names);
  if (!value) throw new Error(`WORKER_CONFIG_REQUIRED:${names[0]}`);
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!isHex(normalized, { strict: true }) || normalized.length !== 66) {
    throw new Error(`WORKER_CONFIG_INVALID:${names[0]}`);
  }
  return normalized;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`WORKER_CONFIG_INVALID:${name}`);
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}

function loadWorkerEnvironment(): void {
  const directory = dirname(fileURLToPath(import.meta.url));
  const root = resolve(directory, "../../../../");
  const rootValues = parseEnvFile(resolve(root, ".env"));
  const workerValues = parseEnvFile(resolve(root, ".env.worker-b"));
  applyWorkerEnvironment(process.env, rootValues, workerValues);
}

function parseEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseDotEnv(readFileSync(path)) : {};
}
