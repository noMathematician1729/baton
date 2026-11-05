import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
import { getEnsResolver, normalize } from "viem/ens";
import { sepolia } from "viem/chains";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
const envText = readFileSync(envPath, "utf8");
const env = parse(envText);
const universalResolver = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";
const roleSetData = 1n << 24n;
const roleSetDataAdmin = roleSetData << 128n;
const worker = getAddress("0x000000000000000000000000000000000000beef");
const resolverAbi = parseAbi([
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
  "function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
]);
const dataSetterAbi = parseAbi(["function setData(bytes name, string key, bytes value)"]);
const authorityAbiPath = resolve(root, "server/contracts/out/JobAuthority.abi.json");
const authorityBytecodePath = resolve(root, "server/contracts/out/JobAuthority.bin");

class WorkflowError extends Error {}

try {
  if (!env.SEPOLIA_RPC_URL) throw new WorkflowError("SEPOLIA_RPC_URL is missing from local .env");
  if (!env.ENS_JOB_NAME) throw new WorkflowError("ENS_JOB_NAME is missing from local .env");
  if (!env.SEPOLIA_DEPLOYER_PRIVATE_KEY) {
    throw new WorkflowError("SEPOLIA_DEPLOYER_PRIVATE_KEY is missing from local .env; enter it locally, never in chat or a command line");
  }
  if (Number(env.SEPOLIA_CHAIN_ID ?? sepolia.id) !== sepolia.id) {
    throw new WorkflowError(`SEPOLIA_CHAIN_ID must be ${sepolia.id}`);
  }

  let authorityAbi;
  let authorityBytecode;
  try {
    authorityAbi = JSON.parse(readFileSync(authorityAbiPath, "utf8"));
    authorityBytecode = `0x${readFileSync(authorityBytecodePath, "utf8").trim().replace(/^0x/, "")}`;
  } catch {
    throw new WorkflowError("Compiled JobAuthority artifacts are missing; run npm run contracts:compile first");
  }
  if (authorityBytecode === "0x") throw new WorkflowError("JobAuthority bytecode is empty");

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

  const ensResolverAddress = getAddress(await getEnsResolver(publicClient, {
    name: normalize(env.ENS_JOB_NAME),
    universalResolverAddress: universalResolver,
  }));
  const configuredResolver = env.ENS_RESOLVER_ADDRESS?.trim();
  if (configuredResolver && getAddress(configuredResolver) !== ensResolverAddress) {
    throw new WorkflowError("Configured ENS_RESOLVER_ADDRESS does not match the current Sepolia resolver for ENS_JOB_NAME");
  }

  const resolverCode = await publicClient.getBytecode({ address: ensResolverAddress });
  if (!resolverCode || resolverCode === "0x") throw new WorkflowError("Resolved ENS resolver has no deployed code");
  const signerCanManage = await publicClient.readContract({
    address: ensResolverAddress,
    abi: resolverAbi,
    functionName: "hasRootRoles",
    args: [roleSetDataAdmin, account.address],
  });
  if (!signerCanManage) throw new WorkflowError("Configured signer lacks root ROLE_SET_DATA_ADMIN on the resolved ENS resolver");

  let adapterAddress;
  const configuredAdapter = env.BATON_AUTHORITY_ADAPTER_ADDRESS?.trim();
  if (configuredAdapter) {
    adapterAddress = getAddress(configuredAdapter);
    const code = await publicClient.getBytecode({ address: adapterAddress });
    if (!code || code === "0x") throw new WorkflowError("Configured BATON_AUTHORITY_ADAPTER_ADDRESS has no deployed code");
  } else {
    const balance = await publicClient.getBalance({ address: account.address });
    if (balance === 0n) throw new WorkflowError(`Deployer ${account.address} has no Sepolia ETH for the adapter deployment`);
    const deploymentHash = await walletClient.deployContract({
      abi: authorityAbi,
      bytecode: authorityBytecode,
      args: [ensResolverAddress],
    });
    console.log(JSON.stringify({ stage: "adapter-submitted", transactionHash: deploymentHash }));
    const receipt = await waitForReceipt(publicClient, deploymentHash);
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new WorkflowError(`Adapter deployment ${deploymentHash} did not produce a successful contract address`);
    }
    adapterAddress = getAddress(receipt.contractAddress);
  }

  const adapterResolver = await publicClient.readContract({
    address: adapterAddress,
    abi: authorityAbi,
    functionName: "ensResolver",
  });
  if (getAddress(adapterResolver) !== ensResolverAddress) {
    throw new WorkflowError("BATON adapter does not point to the resolver currently returned for ENS_JOB_NAME");
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
    throw new WorkflowError("Adapter job key/resource does not match ENSv2 data-key resource derivation");
  }

  const initialRoleBitmap = await publicClient.readContract({
    address: ensResolverAddress,
    abi: resolverAbi,
    functionName: "roles",
    args: [resource, worker],
  });
  if ((initialRoleBitmap & roleSetData) !== 0n) {
    throw new WorkflowError("Random test resource unexpectedly already grants ROLE_SET_DATA; refusing to alter it");
  }

  const initialAuthorized = await authorityCheck(publicClient, adapterAddress, authorityAbi, jobId, worker);
  const initialWrongJobAuthorized = await authorityCheck(publicClient, adapterAddress, authorityAbi, wrongJobId, worker);
  if (initialAuthorized || initialWrongJobAuthorized) {
    throw new WorkflowError("Fresh test job or wrong-job query was already authorized; refusing to continue");
  }

  const setter = encodeFunctionData({
    abi: dataSetterAbi,
    functionName: "setData",
    args: ["0x", jobKey, "0x"],
  });
  let grantAttempted = false;
  try {
    grantAttempted = true;
    const grantHash = await walletClient.writeContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "grantSetterRoles",
      args: [setter, worker],
    });
    console.log(JSON.stringify({ stage: "grant-submitted", transactionHash: grantHash, jobId }));
    await waitForReceipt(publicClient, grantHash);

    const grantedRoleBitmap = await publicClient.readContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "roles",
      args: [resource, worker],
    });
    const grantedAuthorized = await authorityCheck(publicClient, adapterAddress, authorityAbi, jobId, worker);
    const wrongJobAuthorized = await authorityCheck(publicClient, adapterAddress, authorityAbi, wrongJobId, worker);
    if ((grantedRoleBitmap & roleSetData) === 0n || !grantedAuthorized || wrongJobAuthorized) {
      throw new WorkflowError("Grant assertion failed: expected this job authorized and wrong job unauthorized");
    }
    console.log(JSON.stringify({ assertion: "grant => authorized; wrong job => unauthorized", jobId, worker }));

    const revokeHash = await walletClient.writeContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "revokeRoles",
      args: [resource, roleSetData, worker],
    });
    console.log(JSON.stringify({ stage: "revoke-submitted", transactionHash: revokeHash, jobId }));
    await waitForReceipt(publicClient, revokeHash);

    const revokedRoleBitmap = await publicClient.readContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "roles",
      args: [resource, worker],
    });
    if ((revokedRoleBitmap & roleSetData) !== 0n) {
      throw new WorkflowError("Resolver still reports ROLE_SET_DATA after the revoke receipt");
    }
    grantAttempted = false;

    const revokedAuthorized = await authorityCheck(publicClient, adapterAddress, authorityAbi, jobId, worker);
    const revokedWrongJobAuthorized = await authorityCheck(publicClient, adapterAddress, authorityAbi, wrongJobId, worker);
    if (revokedAuthorized || revokedWrongJobAuthorized) {
      throw new WorkflowError("Revoke assertion failed: expected both job queries unauthorized");
    }
    console.log(JSON.stringify({ assertion: "revoke => unauthorized; wrong job => unauthorized", jobId, worker }));
  } finally {
    if (grantAttempted) {
      const remaining = await publicClient.readContract({
        address: ensResolverAddress,
        abi: resolverAbi,
        functionName: "roles",
        args: [resource, worker],
      });
      if ((remaining & roleSetData) !== 0n) {
        const cleanupHash = await walletClient.writeContract({
          address: ensResolverAddress,
          abi: resolverAbi,
          functionName: "revokeRoles",
          args: [resource, roleSetData, worker],
        });
        await waitForReceipt(publicClient, cleanupHash);
        console.log(JSON.stringify({ stage: "test-grant-cleaned-up", transactionHash: cleanupHash, jobId }));
      }
    }
  }

  saveAuthorityAddresses(envText, ensResolverAddress, adapterAddress);
  console.log(JSON.stringify({
    stage: "verified",
    network: "Sepolia",
    chainId,
    ensJobName: normalize(env.ENS_JOB_NAME),
    ensResolverAddress,
    batonAuthorityAdapterAddress: adapterAddress,
    worker,
    jobId,
  }));
} catch (error) {
  if (error instanceof WorkflowError) console.error(`[test:sepolia:authority] ${error.message}`);
  else {
    const code = safeErrorCode(error);
    console.error(`[test:sepolia:authority] Workflow stopped (${String(code)}). RPC URLs and private keys were not printed.`);
  }
  process.exitCode = 1;
}

async function authorityCheck(client, adapterAddress, abi, jobId, workerAddress) {
  return client.readContract({
    address: adapterAddress,
    abi,
    functionName: "hasWorkerGrant",
    args: [jobId, workerAddress],
  });
}

async function waitForReceipt(client, hash) {
  const confirmations = Math.max(1, Number(env.CONFIRMATION_BLOCKS ?? 2));
  return client.waitForTransactionReceipt({ hash, confirmations, timeout: 180_000 });
}

function safeErrorCode(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.code) return current.code;
  }
  return error?.name ?? "Error";
}

function saveAuthorityAddresses(original, ensResolverAddress, adapterAddress) {
  let updated = setEnvLine(original, "ENS_RESOLVER_ADDRESS", ensResolverAddress);
  updated = setEnvLine(updated, "BATON_AUTHORITY_ADAPTER_ADDRESS", adapterAddress);
  const temporaryPath = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, updated, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, envPath);
  chmodSync(envPath, 0o600);
}

function setEnvLine(text, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
}
