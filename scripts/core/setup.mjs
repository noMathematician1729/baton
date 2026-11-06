// BATON two-worker core setup (Sepolia testnet only). Idempotent; never prints secret values.
//  - verifies the configured escrow exposes the V2 protocol marker
//  - deploys the test-only BatonTestToken if BATON_REWARD_TOKEN_ADDRESS is unset
//  - generates BATON_BUYER_API_TOKEN and enables the core service in the buyer .env
//  - copies each worker's own signer/storage settings into .env.worker-<id> (0600)
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const root = resolve(import.meta.dirname, "../..");
const envPath = resolve(root, ".env");
const env = parse(readFileSync(envPath));
const out = (stage, detail = {}) => console.log(JSON.stringify({ stage, ...detail }));

function setLines(path, values) {
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
  }
  const temp = `${path}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

const key = (k) => (k.startsWith("0x") ? k : `0x${k}`);
const rpc = env.SEPOLIA_RPC_URL;
const buyer = privateKeyToAccount(key(env.SEPOLIA_DEPLOYER_PRIVATE_KEY));
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });
if ((await publicClient.getChainId()) !== 11155111) throw new Error("Not Sepolia; refusing");

const escrow = getAddress(env.BATON_ESCROW_ADDRESS);
const marker = await publicClient.readContract({ address: escrow, abi: [{ type: "function", name: "PROTOCOL_VERSION", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" }], functionName: "PROTOCOL_VERSION" });
if (marker !== keccak256(toBytes("BATON_JOB_ESCROW_V2"))) throw new Error("Configured escrow is not V2");
out("escrow-v2-verified", { escrow });

const updates = {};
if (!env.BATON_REWARD_TOKEN_ADDRESS) {
  const artifact = (name) => ({
    abi: JSON.parse(readFileSync(resolve(root, `server/contracts/out/${name}.abi.json`), "utf8")),
    bytecode: `0x${readFileSync(resolve(root, `server/contracts/out/${name}.bin`), "utf8").trim().replace(/^0x/, "")}`,
  });
  const { abi, bytecode } = artifact("BatonTestToken");
  const wallet = createWalletClient({ account: buyer, chain: sepolia, transport: http(rpc) });
  const hash = await wallet.deployContract({ abi, bytecode, account: buyer });
  out("token-submitted", { txHash: hash });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Token deployment failed");
  updates.BATON_REWARD_TOKEN_ADDRESS = receipt.contractAddress;
  out("token-deployed", { token: receipt.contractAddress, txHash: hash, block: receipt.blockNumber.toString() });
} else {
  out("token-reused", { token: env.BATON_REWARD_TOKEN_ADDRESS });
}
if (!env.BATON_BUYER_API_TOKEN) updates.BATON_BUYER_API_TOKEN = randomBytes(32).toString("base64url");
updates.BATON_CORE_ENABLED = "true";
setLines(envPath, updates);
out("buyer-env-updated", { variables: Object.keys(updates) });

const workers = {
  a: { evm: "WORKER_A_EVM_PRIVATE_KEY", arkivSigner: "ARKIV_SIGNER_PRIVATE_KEY_A", arkivKey: env.ARKIV_ACCESS_KEY_A ? "ARKIV_ACCESS_KEY_A" : "ARKIV_ACCESS_KEY", arkivRpc: "ARKIV_RPC_URL_A" },
  b: { evm: "WORKER_B_EVM_PRIVATE_KEY", arkivSigner: "ARKIV_SIGNER_PRIVATE_KEY_B", arkivKey: env.ARKIV_ACCESS_KEY_B ? "ARKIV_ACCESS_KEY_B" : "ARKIV_ACCESS_KEY", arkivRpc: "ARKIV_RPC_URL_B" },
};
for (const [id, names] of Object.entries(workers)) {
  const path = resolve(root, `.env.worker-${id}`);
  if (!existsSync(path)) throw new Error(`.env.worker-${id} missing; run npm run key-service:provision first`);
  const current = parse(readFileSync(path));
  const evm = key(env[names.evm]);
  const address = privateKeyToAccount(evm).address;
  if (getAddress(current.WORKER_ADDRESS) !== address) throw new Error(`.env.worker-${id} WORKER_ADDRESS does not match ${names.evm}`);
  setLines(path, {
    WORKER_EVM_PRIVATE_KEY: evm,
    ARKIV_SIGNER_PRIVATE_KEY: key(env[names.arkivSigner]),
    ARKIV_ACCESS_KEY: env[names.arkivKey],
    ARKIV_RPC_URL: env[names.arkivRpc] ?? "",
    SEPOLIA_RPC_URL: rpc,
  });
  out("worker-env-updated", { worker: id, address, file: `.env.worker-${id}` });
}
