import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
const envText = readFileSync(envPath, "utf8");
const env = parse(envText);

class DeploymentError extends Error {}

try {
  if (!env.SEPOLIA_RPC_URL) throw new DeploymentError("SEPOLIA_RPC_URL is missing from local .env");
  if (!env.SEPOLIA_DEPLOYER_PRIVATE_KEY) {
    throw new DeploymentError("SEPOLIA_DEPLOYER_PRIVATE_KEY is missing from local .env; enter it locally, never in chat or a command line");
  }
  if (env.BATON_ESCROW_ADDRESS) {
    throw new DeploymentError("BATON_ESCROW_ADDRESS is already set; refusing to deploy a duplicate contract");
  }

  const bytecodePath = resolve(root, "server/contracts/out/JobEscrow.bin");
  const abiPath = resolve(root, "server/contracts/out/JobEscrow.abi.json");
  let bytecode;
  let abi;
  try {
    bytecode = `0x${readFileSync(bytecodePath, "utf8").trim().replace(/^0x/, "")}`;
    abi = JSON.parse(readFileSync(abiPath, "utf8"));
  } catch {
    throw new DeploymentError("Compiled JobEscrow artifacts are missing; run npm run contracts:compile first");
  }
  if (bytecode === "0x") throw new DeploymentError("JobEscrow bytecode is empty; compile the contract before deployment");

  const key = (env.SEPOLIA_DEPLOYER_PRIVATE_KEY.startsWith("0x")
    ? env.SEPOLIA_DEPLOYER_PRIVATE_KEY
    : `0x${env.SEPOLIA_DEPLOYER_PRIVATE_KEY}`);
  let account;
  try {
    account = privateKeyToAccount(key);
  } catch {
    throw new DeploymentError("SEPOLIA_DEPLOYER_PRIVATE_KEY is malformed; correct it in local .env");
  }

  const expectedChainId = Number(env.SEPOLIA_CHAIN_ID ?? sepolia.id);
  if (expectedChainId !== sepolia.id) throw new DeploymentError(`SEPOLIA_CHAIN_ID must be ${sepolia.id}`);

  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== sepolia.id) {
    throw new DeploymentError(`RPC returned chain ID ${actualChainId}; expected Sepolia ${sepolia.id}. Nothing was deployed`);
  }
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) throw new DeploymentError(`Deployer ${account.address} has no Sepolia ETH for gas; fund this testnet address and retry`);

  console.log(JSON.stringify({ stage: "ready", network: "Sepolia", chainId: actualChainId, deployer: account.address, balanceEth: formatEther(balance) }));
  const hash = await walletClient.deployContract({ abi, bytecode, account });
  console.log(JSON.stringify({ stage: "submitted", transactionHash: hash }));

  const confirmations = Math.max(1, Number(env.CONFIRMATION_BLOCKS ?? 2));
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations, timeout: 180_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new DeploymentError(`Deployment transaction ${hash} did not produce a successful contract address`);
  }
  const deployedCode = await publicClient.getBytecode({ address: receipt.contractAddress });
  if (!deployedCode || deployedCode === "0x") {
    throw new DeploymentError(`No code found at ${receipt.contractAddress}; BATON_ESCROW_ADDRESS was not changed`);
  }

  saveEscrowAddress(envText, receipt.contractAddress);
  console.log(JSON.stringify({ stage: "confirmed", network: "Sepolia", chainId: actualChainId, contractAddress: receipt.contractAddress, transactionHash: hash, blockNumber: receipt.blockNumber.toString(), confirmations }));
} catch (error) {
  if (error instanceof DeploymentError) console.error(`[deploy:escrow] ${error.message}`);
  else console.error("[deploy:escrow] Deployment stopped. Check RPC connectivity and transaction status; the deployer key was not printed.");
  process.exitCode = 1;
}

function saveEscrowAddress(original, address) {
  const line = `BATON_ESCROW_ADDRESS=${address}`;
  const updated = /^BATON_ESCROW_ADDRESS=.*$/m.test(original)
    ? original.replace(/^BATON_ESCROW_ADDRESS=.*$/m, line)
    : `${original.replace(/\s*$/, "")}\n${line}\n`;
  const temporaryPath = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, updated, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, envPath);
  chmodSync(envPath, 0o600);
}
