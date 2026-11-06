import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse } from "dotenv";
import { getAddress, isHex, type Hex } from "viem";
import { CoreService, type CoreConfig } from "./coreService.js";

/**
 * Builds the two-worker core service from the buyer host's private configuration.
 * Variable names only are documented in test.md; values stay in ignored env files.
 */
export function createCoreServiceFromEnv(repoRoot: string, serverRoot: string): CoreService | undefined {
  const e = process.env;
  if (e.BATON_CORE_ENABLED !== "true") return undefined;
  // Never resume live jobs from inside a test process that happens to load the buyer .env.
  if (e.NODE_TEST_CONTEXT || e.NODE_ENV === "test" || process.execArgv.includes("--test")) return undefined;
  const need = (name: string, value = e[name]) => {
    if (!value?.trim()) throw new Error(`BATON core: ${name} is required`);
    return value.trim();
  };
  const keyServiceEnv = parse(readFileSync(resolve(repoRoot, e.BATON_KEY_SERVICE_ENV_FILE ?? ".env.key-service")));
  const keyServiceDb = need("CHECKPOINT_KEY_SERVICE_DATABASE_PATH", keyServiceEnv.CHECKPOINT_KEY_SERVICE_DATABASE_PATH);
  const buyerKey = need("SEPOLIA_DEPLOYER_PRIVATE_KEY");
  const kek = need("CHECKPOINT_ENCRYPTION_KEY").replace(/^0x/, "");
  const workerLaunchSetting = e.BATON_CORE_WORKER_LAUNCH_ENABLED?.trim().toLowerCase();
  if (workerLaunchSetting && workerLaunchSetting !== "true" && workerLaunchSetting !== "false") {
    throw new Error("BATON_CORE_WORKER_LAUNCH_ENABLED must be true or false");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(kek)) throw new Error("BATON core: CHECKPOINT_ENCRYPTION_KEY must be 32 bytes hex");
  const privateKey = (buyerKey.startsWith("0x") ? buyerKey : `0x${buyerKey}`) as Hex;
  if (!isHex(privateKey) || privateKey.length !== 66) throw new Error("BATON core: buyer key invalid");
  const config: CoreConfig = {
    repoRoot,
    dataDir: resolve(repoRoot, e.BATON_CORE_DATA_DIR ?? ".baton-data/core"),
    rpcUrl: need("SEPOLIA_RPC_URL"),
    chainId: Number(e.SEPOLIA_CHAIN_ID ?? 11155111),
    buyerPrivateKey: privateKey,
    escrow: getAddress(need("BATON_ESCROW_ADDRESS")),
    rewardToken: getAddress(need("BATON_REWARD_TOKEN_ADDRESS")),
    ensParent: need("ENS_JOB_NAME"),
    contractsOut: resolve(serverRoot, "contracts/out"),
    keyEncryptionKey: kek,
    keyServiceDbPath: isAbsolute(keyServiceDb) ? keyServiceDb : resolve(repoRoot, keyServiceDb),
    keyServiceStorageKey: need("CHECKPOINT_KEY_SERVICE_STORAGE_KEY", keyServiceEnv.CHECKPOINT_KEY_SERVICE_STORAGE_KEY),
    arkivAccessKey: need("BATON_BUYER_ARKIV_ACCESS_KEY", e.BATON_BUYER_ARKIV_ACCESS_KEY ?? e.ARKIV_ACCESS_KEY),
    arkivRpcUrl: e.BATON_BUYER_ARKIV_RPC_URL || e.ARKIV_RPC_URL || undefined,
    buyerApiToken: need("BATON_BUYER_API_TOKEN"),
    apiUrl: e.BATON_API_URL ?? `http://${e.SERVER_HOST ?? "127.0.0.1"}:${e.SERVER_PORT ?? 4000}`,
    confirmations: Number(e.BATON_CORE_CONFIRMATIONS ?? 2),
    workerLaunchEnabled: workerLaunchSetting ? workerLaunchSetting === "true" : e.NODE_ENV !== "production",
  };
  if (config.chainId !== 11155111) throw new Error("BATON core runs on Sepolia only");
  return new CoreService(config);
}
