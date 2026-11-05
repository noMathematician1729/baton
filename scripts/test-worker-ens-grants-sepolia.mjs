import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = parse(readFileSync(resolve(root, ".env"), "utf8"));
const roleSetData = 1n << 24n;
const roleSetDataAdmin = roleSetData << 128n;
const zeroAddress = "0x0000000000000000000000000000000000000000";
const resolverAbi = parseAbi([
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
  "function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
]);
const setterAbi = parseAbi(["function setData(bytes name, string key, bytes value)"]);
const authorityAbi = JSON.parse(readFileSync(resolve(root, "server/contracts/out/JobAuthority.abi.json"), "utf8"));
const authorityAdapterAbi = parseAbi(["function ensResolver() view returns (address)"]);

class WorkflowError extends Error {}

try {
  if (!env.SEPOLIA_RPC_URL) throw new WorkflowError("SEPOLIA_RPC_URL is missing from local .env");
  if (!env.SEPOLIA_DEPLOYER_PRIVATE_KEY) throw new WorkflowError("SEPOLIA_DEPLOYER_PRIVATE_KEY is missing from local .env");
  if (!env.ENS_RESOLVER_ADDRESS || !env.BATON_AUTHORITY_ADAPTER_ADDRESS || !env.BATON_ESCROW_ADDRESS) {
    throw new WorkflowError("Set ENS_RESOLVER_ADDRESS, BATON_AUTHORITY_ADAPTER_ADDRESS, and BATON_ESCROW_ADDRESS before the worker grant checks");
  }
  if (!env.WORKER_A_ADDRESS || !env.WORKER_B_ADDRESS) {
    throw new WorkflowError("Set the public WORKER_A_ADDRESS and WORKER_B_ADDRESS values in local .env; no worker private keys are needed by this test");
  }
  if (Number(env.SEPOLIA_CHAIN_ID ?? sepolia.id) !== sepolia.id) {
    throw new WorkflowError(`SEPOLIA_CHAIN_ID must be ${sepolia.id}`);
  }

  const ensResolverAddress = getAddress(env.ENS_RESOLVER_ADDRESS);
  const adapterAddress = getAddress(env.BATON_AUTHORITY_ADAPTER_ADDRESS);
  const escrowAddress = getAddress(env.BATON_ESCROW_ADDRESS);
  const workerA = requiredWorkerAddress("WORKER_A_ADDRESS", env.WORKER_A_ADDRESS);
  const workerB = requiredWorkerAddress("WORKER_B_ADDRESS", env.WORKER_B_ADDRESS);
  if (workerA === workerB) throw new WorkflowError("Worker A and Worker B addresses must be different");

  const privateKey = env.SEPOLIA_DEPLOYER_PRIVATE_KEY.startsWith("0x")
    ? env.SEPOLIA_DEPLOYER_PRIVATE_KEY
    : `0x${env.SEPOLIA_DEPLOYER_PRIVATE_KEY}`;
  let account;
  try {
    account = privateKeyToAccount(privateKey);
  } catch {
    throw new WorkflowError("SEPOLIA_DEPLOYER_PRIVATE_KEY is malformed; correct it in local .env");
  }

  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
  const chainId = await publicClient.getChainId();
  if (chainId !== sepolia.id) throw new WorkflowError(`RPC returned chain ID ${chainId}; expected Sepolia`);

  for (const [label, address] of [
    ["ENS resolver", ensResolverAddress],
    ["BATON authority adapter", adapterAddress],
    ["BATON escrow", escrowAddress],
  ]) {
    const code = await publicClient.getBytecode({ address });
    if (!code || code === "0x") throw new WorkflowError(`${label} has no deployed code on Sepolia`);
  }
  const adapterResolver = await publicClient.readContract({
    address: adapterAddress,
    abi: authorityAdapterAbi,
    functionName: "ensResolver",
  });
  if (getAddress(adapterResolver) !== ensResolverAddress) {
    throw new WorkflowError("BATON authority adapter does not point to ENS_RESOLVER_ADDRESS");
  }
  const signerCanManage = await publicClient.readContract({
    address: ensResolverAddress,
    abi: resolverAbi,
    functionName: "hasRootRoles",
    args: [roleSetDataAdmin, account.address],
  });
  if (!signerCanManage) throw new WorkflowError("Configured deployer lacks root ROLE_SET_DATA_ADMIN on the ENS resolver");

  const workers = [
    { label: "Worker A", address: workerA },
    { label: "Worker B", address: workerB },
  ];
  for (const worker of workers) {
    const hasRootDataRole = await publicClient.readContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "hasRootRoles",
      args: [roleSetData, worker.address],
    });
    if (hasRootDataRole) {
      throw new WorkflowError(`${worker.label} has resolver-wide ROLE_SET_DATA; scoped revoke would not remove that global permission`);
    }
  }

  const jobId = keccak256(toHex(randomBytes(32)));
  const wrongJobId = keccak256(jobId);
  const jobKey = `baton.job.v1:${jobId.slice(2)}`;
  const resource = BigInt(keccak256(stringToHex(jobKey)));
  const adapterJobKey = await publicClient.readContract({
    address: adapterAddress,
    abi: authorityAbi,
    functionName: "jobGrantKey",
    args: [jobId],
  });
  const adapterResource = await publicClient.readContract({
    address: adapterAddress,
    abi: authorityAbi,
    functionName: "jobResource",
    args: [jobId],
  });
  if (adapterJobKey !== jobKey || adapterResource !== resource) {
    throw new WorkflowError("Adapter job key/resource does not match ENS data-key derivation");
  }

  const setter = encodeFunctionData({ abi: setterAbi, functionName: "setData", args: ["0x", jobKey, "0x"] });
  console.log(JSON.stringify({
    stage: "preflight",
    network: "Sepolia",
    chainId,
    ensResolverAddress,
    batonAuthorityAdapterAddress: adapterAddress,
    batonEscrowAddress: escrowAddress,
    workerA: workerA,
    workerB: workerB,
    temporaryJobId: jobId,
  }));

  for (const worker of workers) {
    await assertInitiallyUnauthorized(publicClient, ensResolverAddress, adapterAddress, worker.address, resource, jobId, wrongJobId, authorityAbi, worker.label);
    await testGrantAndRevoke({
      publicClient,
      walletClient,
      ensResolverAddress,
      adapterAddress,
      worker,
      setter,
      resource,
      jobId,
      wrongJobId,
      authorityAbi,
    });
  }

  console.log(JSON.stringify({ stage: "verified", assertions: [
    "Worker A grant => authorized",
    "Worker A wrong job => unauthorized",
    "Worker A revoke => unauthorized",
    "Worker B grant => authorized",
    "Worker B wrong job => unauthorized",
    "Worker B revoke => unauthorized",
  ], temporaryJobId: jobId }));
} catch (error) {
  if (error instanceof WorkflowError) console.error(`[test:sepolia:worker-grants] ${error.message}`);
  else console.error(`[test:sepolia:worker-grants] Workflow stopped (${safeErrorCode(error)}). RPC URLs and private keys were not printed.`);
  process.exitCode = 1;
}

function requiredWorkerAddress(name, value) {
  let address;
  try {
    address = getAddress(value);
  } catch {
    throw new WorkflowError(`${name} is malformed; set its public EVM address in local .env`);
  }
  if (address === zeroAddress) throw new WorkflowError(`${name} cannot be the zero address`);
  return address;
}

async function assertInitiallyUnauthorized(client, resolver, adapter, worker, resource, jobId, wrongJobId, adapterAbi, label) {
  const roleBitmap = await client.readContract({
    address: resolver,
    abi: resolverAbi,
    functionName: "roles",
    args: [resource, worker],
  });
  if ((roleBitmap & roleSetData) !== 0n) throw new WorkflowError(`${label} unexpectedly has a role on the fresh random job resource`);
  const authorized = await authorityCheck(client, adapter, adapterAbi, jobId, worker);
  if (authorized) throw new WorkflowError(`${label} was authorized before its test grant`);
  const wrongJobAuthorized = await authorityCheck(client, adapter, adapterAbi, wrongJobId, worker);
  if (wrongJobAuthorized) throw new WorkflowError(`${label} was authorized for the wrong job before its test grant`);
}

async function testGrantAndRevoke({ publicClient, walletClient, ensResolverAddress, adapterAddress, worker, setter, resource, jobId, wrongJobId, authorityAbi: adapterAbi }) {
  let grantMayExist = false;
  try {
    grantMayExist = true;
    const grantHash = await walletClient.writeContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "grantSetterRoles",
      args: [setter, worker.address],
    });
    console.log(JSON.stringify({ stage: "grant-submitted", worker: worker.label, transactionHash: grantHash }));
    await waitForSuccessfulReceipt(publicClient, grantHash);

    const roleBitmap = await publicClient.readContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "roles",
      args: [resource, worker.address],
    });
    const eacAuthorized = await publicClient.readContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "hasRoles",
      args: [resource, roleSetData, worker.address],
    });
    const authorized = await authorityCheck(publicClient, adapterAddress, adapterAbi, jobId, worker.address);
    const wrongJobAuthorized = await authorityCheck(publicClient, adapterAddress, adapterAbi, wrongJobId, worker.address);
    if ((roleBitmap & roleSetData) === 0n || !eacAuthorized || !authorized || wrongJobAuthorized) {
      throw new WorkflowError(`${worker.label} grant assertion failed`);
    }
    console.log(JSON.stringify({ assertion: `${worker.label} grant => authorized; wrong job => unauthorized`, worker: worker.address }));

    const revokeHash = await walletClient.writeContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "revokeRoles",
      args: [resource, roleSetData, worker.address],
    });
    console.log(JSON.stringify({ stage: "revoke-submitted", worker: worker.label, transactionHash: revokeHash }));
    await waitForSuccessfulReceipt(publicClient, revokeHash);

    const revokedRoleBitmap = await publicClient.readContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "roles",
      args: [resource, worker.address],
    });
    const eacStillAuthorized = await publicClient.readContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "hasRoles",
      args: [resource, roleSetData, worker.address],
    });
    if ((revokedRoleBitmap & roleSetData) !== 0n || eacStillAuthorized) {
      throw new WorkflowError(`${worker.label} resolver revoke did not remove the scoped permission`);
    }
    grantMayExist = false;
    const revokedAuthorized = await authorityCheck(publicClient, adapterAddress, adapterAbi, jobId, worker.address);
    const revokedWrongJobAuthorized = await authorityCheck(publicClient, adapterAddress, adapterAbi, wrongJobId, worker.address);
    if (revokedAuthorized || revokedWrongJobAuthorized) throw new WorkflowError(`${worker.label} revoke assertion failed`);
    console.log(JSON.stringify({ assertion: `${worker.label} revoke => unauthorized; wrong job => unauthorized`, worker: worker.address }));
  } finally {
    if (grantMayExist) {
      const remaining = await publicClient.readContract({
        address: ensResolverAddress,
        abi: resolverAbi,
        functionName: "roles",
        args: [resource, worker.address],
      });
      if ((remaining & roleSetData) !== 0n) {
        const cleanupHash = await walletClient.writeContract({
          address: ensResolverAddress,
          abi: resolverAbi,
          functionName: "revokeRoles",
          args: [resource, roleSetData, worker.address],
        });
        await waitForSuccessfulReceipt(publicClient, cleanupHash);
        console.log(JSON.stringify({ stage: "temporary-grant-cleaned-up", worker: worker.label, transactionHash: cleanupHash }));
      }
    }
  }
}

async function authorityCheck(client, adapter, abi, jobId, worker) {
  return client.readContract({ address: adapter, abi, functionName: "hasWorkerGrant", args: [jobId, worker] });
}

async function waitForSuccessfulReceipt(client, hash) {
  const confirmations = Math.max(1, Number(env.CONFIRMATION_BLOCKS ?? 2));
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations, timeout: 180_000 });
  if (receipt.status !== "success") throw new WorkflowError(`Transaction ${hash} did not succeed`);
  return receipt;
}

function safeErrorCode(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.code) return current.code;
  }
  return error?.name ?? "Error";
}
