import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVER_HOST: z.string().default("127.0.0.1"),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CLIENT_ORIGIN: z.string().url().default("http://127.0.0.1:5173"),
  DATABASE_URL: z.string().default(""),
  SEPOLIA_RPC_URL: z.string().default(""),
  SEPOLIA_CHAIN_ID: z.coerce.number().int().default(11155111),
  BATON_ESCROW_ADDRESS: z.string().default(""),
  ENS_JOB_NAME: z.string().default(""),
  ENS_RESOLVER_ADDRESS: z.string().default(""),
  ARKIV_NETWORK: z.string().default("rabdi"),
  ARKIV_RPC_URL: z.string().default(""),
  ARKIV_ACCESS_KEY: z.string().default(""),
  ARKIV_SIGNER_PRIVATE_KEY: z.string().default(""),
  WORKER_EVM_PRIVATE_KEY: z.string().default(""),
  CHECKPOINT_ENCRYPTION_KEY: z.string().default(""),
  CHECKPOINT_KEY_ID: z.string().default("local-dev"),
  CHECKPOINT_KEY_SERVICE_URL: z.string().default(""),
  HEDERA_NETWORK: z.string().default("testnet"),
  HEDERA_ACCOUNT_ID: z.string().default(""),
  HEDERA_PRIVATE_KEY: z.string().default(""),
  HEDERA_MIRROR_NODE_URL: z.string().url().default("https://testnet.mirrornode.hedera.com"),
  X402_FACILITATOR_URL: z.string().default(""),
  X402_NETWORK: z.string().default("hedera:testnet"),
  LOG_LEVEL: z.string().default("info"),
});

export const env = schema.parse(process.env);
