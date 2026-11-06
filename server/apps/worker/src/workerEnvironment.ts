type Environment = Record<string, string | undefined>;

const forbiddenRootKeys = [
  "SEPOLIA_DEPLOYER_PRIVATE_KEY", "BUYER_SEPOLIA_SIGNER", "BATON_BUYER_EVM_PRIVATE_KEY",
  "WORKER_A_EVM_PRIVATE_KEY", "ARKIV_SIGNER_PRIVATE_KEY", "ARKIV_SIGNER_PRIVATE_KEY_A",
  "ARKIV_SIGNER_PRIVATE_KEY_B", "HEDERA_PRIVATE_KEY",
];

const allowedRootKeys = [
  "SERVER_PORT", "SEPOLIA_RPC_URL", "SEPOLIA_RPC_BACKUP_URLS", "SEPOLIA_CHAIN_ID", "CONFIRMATION_BLOCKS",
  "BATON_ESCROW_ADDRESS", "BATON_AUTHORITY_ADAPTER_ADDRESS", "WORKER_B_ADDRESS", "WORKER_B_EVM_PRIVATE_KEY",
  "ARKIV_RPC_URL_B", "ARKIV_ACCESS_KEY", "ARKIV_ACCESS_KEY_B", "ARKIV_STORAGE_OWNER_ADDRESS",
];

const workerKeys = [
  "BATON_API_URL", "SEPOLIA_RPC_URL", "SEPOLIA_RPC_BACKUP_URLS", "SEPOLIA_CHAIN_ID", "CONFIRMATION_BLOCKS",
  "BATON_ESCROW_ADDRESS", "BATON_AUTHORITY_ADAPTER_ADDRESS", "WORKER_ADDRESS", "WORKER_EVM_PRIVATE_KEY",
  "WORKER_B_EVM_PRIVATE_KEY", "ARKIV_RPC_URL", "ARKIV_RPC_URL_B", "ARKIV_ACCESS_KEY", "ARKIV_ACCESS_KEY_B",
  "ARKIV_STORAGE_OWNER_ADDRESS", "CHECKPOINT_KEY_SERVICE_URL", "CHECKPOINT_KEY_SERVICE_TOKEN",
  "CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY", "MCP_SERVER_URL", "MCP_API_KEY", "MCP_EXPECTED_SERVER_ID",
  "MCP_PROBE_TOOL_NAME", "MCP_PROBE_SCHEMA_VERSION", "MCP_PROBE_SCHEMA_DIGEST", "MCP_PROBE_INPUT_JSON",
  "MCP_PROBE_EXPECTED_OUTPUT_DIGEST", "MCP_PROBE_TIMEOUT_MS",
];

/** Overlay only B's operational values; never inherit the buyer or Worker A signers. */
export function applyWorkerEnvironment(
  environment: Environment,
  rootValues: Record<string, string>,
  workerValues: Record<string, string>,
): void {
  for (const name of forbiddenRootKeys) delete environment[name];
  for (const name of allowedRootKeys) {
    if (environment[name] === undefined && workerValues[name] === undefined && rootValues[name] !== undefined) {
      environment[name] = rootValues[name];
    }
  }
  for (const name of workerKeys) {
    if (environment[name] === undefined && workerValues[name] !== undefined) environment[name] = workerValues[name];
  }
  if (!environment.WORKER_ADDRESS && environment.WORKER_B_ADDRESS) environment.WORKER_ADDRESS = environment.WORKER_B_ADDRESS;
  if (!environment.WORKER_EVM_PRIVATE_KEY && environment.WORKER_B_EVM_PRIVATE_KEY) {
    environment.WORKER_EVM_PRIVATE_KEY = environment.WORKER_B_EVM_PRIVATE_KEY;
  }
  if (!environment.ARKIV_RPC_URL && environment.ARKIV_RPC_URL_B) environment.ARKIV_RPC_URL = environment.ARKIV_RPC_URL_B;
  if (!environment.ARKIV_ACCESS_KEY && environment.ARKIV_ACCESS_KEY_B) environment.ARKIV_ACCESS_KEY = environment.ARKIV_ACCESS_KEY_B;
}
