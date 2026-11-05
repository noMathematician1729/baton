import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
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
let envText = readFileSync(envPath, "utf8");
const env = parse(envText);
const escrowAbi = JSON.parse(readFileSync(resolve(root, "server/contracts/out/JobEscrow.abi.json"), "utf8"));
const tokenAbi = JSON.parse(readFileSync(resolve(root, "server/contracts/out/BatonTestToken.abi.json"), "utf8"));
const tokenBytecode = `0x${readFileSync(resolve(root, "server/contracts/out/BatonTestToken.bin"), "utf8").trim().replace(/^0x/, "")}`;
const adapterAbi = parseAbi([
  "function ensResolver() view returns (address)",
  "function jobGrantKey(bytes32 jobId) view returns (string)",
  "function jobResource(bytes32 jobId) view returns (uint256)",
  "function hasWorkerGrant(bytes32 jobId, address worker) view returns (bool)",
]);
const resolverAbi = parseAbi([
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
  "function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
]);
const setterAbi = parseAbi(["function setData(bytes name, string key, bytes value)"]);
const offerTypes = {
  MilestoneOffer: [
    { name: "jobId", type: "bytes32" },
    { name: "taskId", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "producer", type: "address" },
    { name: "epoch", type: "uint64" },
    { name: "milestone", type: "uint32" },
    { name: "expectedHead", type: "bytes32" },
    { name: "newHead", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
};
const takeoverTypes = {
  TakeoverAck: [
    { name: "jobId", type: "bytes32" },
    { name: "taskId", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "successor", type: "address" },
    { name: "epoch", type: "uint64" },
    { name: "expectedHead", type: "bytes32" },
    { name: "compatibilityReport", type: "bytes32" },
    { name: "servicePolicy", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
};

const roleSetData = 1n << 24n;
const roleSetDataAdmin = roleSetData << 128n;
const universalResolver = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";
const emptyHead = `0x${"00".repeat(32)}`;
const tokenUnit = 10n ** 18n;
const rewards = [3n, 3n, 4n].map((amount) => amount * tokenUnit);
const totalReward = rewards.reduce((sum, amount) => sum + amount, 0n);

class DemoError extends Error {}

let publicClient;
let buyerWallet;
let ensResolverAddress;
let adapterAddress;
let workerAAddress;
let workerBAddress;
let jobId;
let resource;
let evidence;
let evidencePath;
let workerAGrantMayExist = false;
let workerBGrantMayExist = false;

try {
  requireSetting("SEPOLIA_RPC_URL");
  requireSetting("SEPOLIA_DEPLOYER_PRIVATE_KEY");
  requireSetting("BATON_ESCROW_ADDRESS");
  requireSetting("ENS_JOB_NAME");
  requireSetting("ENS_RESOLVER_ADDRESS");
  requireSetting("BATON_AUTHORITY_ADAPTER_ADDRESS");
  requireSetting("WORKER_A_ADDRESS");
  requireSetting("WORKER_B_ADDRESS");
  requireSetting("WORKER_A_EVM_PRIVATE_KEY");

  const buyer = accountFromEnv("SEPOLIA_DEPLOYER_PRIVATE_KEY");
  const workerA = accountFromEnv("WORKER_A_EVM_PRIVATE_KEY");
  const workerB = accountFromEnv("WORKER_B_EVM_PRIVATE_KEY", "WORKER_EVM_PRIVATE_KEY");
  const escrowAddress = checksumSetting("BATON_ESCROW_ADDRESS");
  adapterAddress = checksumSetting("BATON_AUTHORITY_ADAPTER_ADDRESS");
  ensResolverAddress = checksumSetting("ENS_RESOLVER_ADDRESS");
  workerAAddress = checksumSetting("WORKER_A_ADDRESS");
  workerBAddress = checksumSetting("WORKER_B_ADDRESS");
  if (buyer.address === workerA.address || buyer.address === workerB.address || workerA.address === workerB.address) {
    throw new DemoError("Buyer, Worker A, and Worker B must be three distinct addresses");
  }
  if (workerA.address !== workerAAddress) throw new DemoError("WORKER_A_EVM_PRIVATE_KEY does not derive to WORKER_A_ADDRESS");
  if (workerB.address !== workerBAddress) throw new DemoError("Worker B key does not derive to WORKER_B_ADDRESS");

  const expectedChainId = Number(env.SEPOLIA_CHAIN_ID ?? sepolia.id);
  if (expectedChainId !== sepolia.id) throw new DemoError(`SEPOLIA_CHAIN_ID must be ${sepolia.id}`);
  const chainId = sepolia.id;
  publicClient = createPublicClient({ chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
  buyerWallet = createWalletClient({ account: buyer, chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
  const workerAWallet = createWalletClient({ account: workerA, chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });
  const workerBWallet = createWalletClient({ account: workerB, chain: sepolia, transport: http(env.SEPOLIA_RPC_URL) });

  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== sepolia.id) throw new DemoError(`RPC returned chain ID ${actualChainId}; expected Sepolia`);
  const resolvedNameResolver = getAddress(await getEnsResolver(publicClient, {
    name: normalize(env.ENS_JOB_NAME),
    universalResolverAddress: universalResolver,
  }));
  if (resolvedNameResolver !== ensResolverAddress) throw new DemoError("ENS_RESOLVER_ADDRESS no longer matches the live resolver for ENS_JOB_NAME");

  await requireCode(publicClient, escrowAddress, "configured BATON escrow");
  await requireCode(publicClient, adapterAddress, "configured BATON authority adapter");
  await requireCode(publicClient, ensResolverAddress, "configured ENS resolver");
  const adapterResolver = await publicClient.readContract({ address: adapterAddress, abi: adapterAbi, functionName: "ensResolver" });
  if (getAddress(adapterResolver) !== ensResolverAddress) throw new DemoError("Authority adapter points to a different ENS resolver");
  const signerCanManage = await publicClient.readContract({
    address: ensResolverAddress,
    abi: resolverAbi,
    functionName: "hasRootRoles",
    args: [roleSetDataAdmin, buyer.address],
  });
  if (!signerCanManage) throw new DemoError("Buyer signer lacks root ROLE_SET_DATA_ADMIN on the ENS resolver");
  for (const [label, address] of [["Worker A", workerAAddress], ["Worker B", workerBAddress]]) {
    const rootDataRole = await publicClient.readContract({
      address: ensResolverAddress,
      abi: resolverAbi,
      functionName: "hasRootRoles",
      args: [roleSetData, address],
    });
    if (rootDataRole) throw new DemoError(`${label} has resolver-wide ROLE_SET_DATA; job-scoped revocation would not remove that global role`);
  }

  const buyerEth = await publicClient.getBalance({ address: buyer.address });
  const workerAEth = await publicClient.getBalance({ address: workerAAddress });
  const workerBEth = await publicClient.getBalance({ address: workerBAddress });
  if (buyerEth === 0n || workerAEth === 0n || workerBEth === 0n) {
    throw new DemoError("Buyer and both workers need Sepolia ETH for their planned transactions; no job was funded");
  }

  jobId = keccak256(toHex(randomBytes(32)));
  const wrongJobId = keccak256(jobId);
  const jobKey = `baton.job.v1:${jobId.slice(2)}`;
  resource = BigInt(keccak256(stringToHex(jobKey)));
  const adapterJobKey = await publicClient.readContract({ address: adapterAddress, abi: adapterAbi, functionName: "jobGrantKey", args: [jobId] });
  const adapterResource = await publicClient.readContract({ address: adapterAddress, abi: adapterAbi, functionName: "jobResource", args: [jobId] });
  if (adapterJobKey !== jobKey || adapterResource !== resource) throw new DemoError("Adapter job key/resource derivation mismatch");
  for (const address of [workerAAddress, workerBAddress]) {
    const currentRoleBitmap = await publicClient.readContract({ address: ensResolverAddress, abi: resolverAbi, functionName: "roles", args: [resource, address] });
    if ((currentRoleBitmap & roleSetData) !== 0n) throw new DemoError("Fresh random job resource unexpectedly has a worker grant");
    if (await authorityCheck(publicClient, adapterAddress, jobId, address)) throw new DemoError("Fresh random job unexpectedly authorizes a worker");
  }

  const taskId = hashText(`${jobId}:task`);
  const termsHash = hashText(JSON.stringify({ protocol: "baton.protocol.v1", jobId, taskId, workerA: workerAAddress, workerB: workerBAddress, rewards: ["3", "3", "4"], rewardTokenDecimals: 18 }));
  const heads = [1, 2, 3].map((index) => hashText(`${jobId}:accepted-head:${index}`));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiry = now + 4n * 60n * 60n;
  const cutoff = now + 6n * 60n * 60n;
  const domain = { name: "BATON Job Escrow", version: "1", chainId, verifyingContract: escrowAddress };
  const offerA = makeOffer({ jobId, taskId, termsHash, producer: workerAAddress, epoch: 1n, milestone: 0, expectedHead: emptyHead, newHead: heads[0], expiry });
  const staleOfferA = makeOffer({ jobId, taskId, termsHash, producer: workerAAddress, epoch: 1n, milestone: 1, expectedHead: heads[0], newHead: heads[1], expiry });
  const offerB1 = makeOffer({ jobId, taskId, termsHash, producer: workerBAddress, epoch: 2n, milestone: 1, expectedHead: heads[0], newHead: heads[1], expiry });
  const offerB2 = makeOffer({ jobId, taskId, termsHash, producer: workerBAddress, epoch: 2n, milestone: 2, expectedHead: heads[1], newHead: heads[2], expiry });
  const [signatureA, staleSignatureA, signatureB1, signatureB2] = await Promise.all([
    workerA.signTypedData({ domain, types: offerTypes, primaryType: "MilestoneOffer", message: offerA }),
    workerA.signTypedData({ domain, types: offerTypes, primaryType: "MilestoneOffer", message: staleOfferA }),
    workerB.signTypedData({ domain, types: offerTypes, primaryType: "MilestoneOffer", message: offerB1 }),
    workerB.signTypedData({ domain, types: offerTypes, primaryType: "MilestoneOffer", message: offerB2 }),
  ]);
  const takeoverAck = {
    jobId,
    taskId,
    termsHash,
    successor: workerBAddress,
    epoch: 1n,
    expectedHead: heads[0],
    compatibilityReport: hashText(`${jobId}:worker-b-compatibility`),
    servicePolicy: hashText(`${jobId}:service-policy`),
    nonce: randomNonce(),
    expiry,
  };
  const takeoverSignature = await workerB.signTypedData({ domain, types: takeoverTypes, primaryType: "TakeoverAck", message: takeoverAck });

  evidencePath = resolve(root, "evidence", "sepolia-jobs", `${jobId.slice(2)}.json`);
  evidence = {
    schema: "baton.sepolia-job-evidence.v1",
    network: "Sepolia",
    chainId,
    createdAt: new Date().toISOString(),
    status: "RUNNING",
    addresses: { escrow: escrowAddress, authorityAdapter: adapterAddress, ensResolver: ensResolverAddress, buyer: buyer.address, workerA: workerAAddress, workerB: workerBAddress },
    job: { jobId, taskId, termsHash, jobKey, rewardToken: env.BATON_REWARD_TOKEN_ADDRESS || null, rewards: rewards.map(String), total: totalReward.toString(), decimals: 18, heads, cutoff: cutoff.toString() },
    transactions: {},
    assertions: [],
    result: null,
  };
  persistEvidence();
  console.log(JSON.stringify({ stage: "preflight-passed", chainId, escrowAddress, workerA: workerAAddress, workerB: workerBAddress, temporaryJobId: jobId }));

  let tokenAddress;
  let tokenDeployedByThisRun = false;
  const configuredToken = env.BATON_REWARD_TOKEN_ADDRESS?.trim();
  if (configuredToken) {
    tokenAddress = getAddress(configuredToken);
    await requireCode(publicClient, tokenAddress, "configured BATON reward token");
  } else {
    if (!tokenBytecode || tokenBytecode === "0x") throw new DemoError("BatonTestToken bytecode is empty; run npm run contracts:compile first");
    const deployment = await sendAndConfirm("deploy-test-token", () => buyerWallet.deployContract({ abi: tokenAbi, bytecode: tokenBytecode }));
    if (deployment.receipt.status !== "success" || !deployment.receipt.contractAddress) throw new DemoError("Test token deployment failed; no token address was saved");
    tokenAddress = getAddress(deployment.receipt.contractAddress);
    await requireCode(publicClient, tokenAddress, "new BATON test reward token");
    saveEnvField("BATON_REWARD_TOKEN_ADDRESS", tokenAddress);
    env.BATON_REWARD_TOKEN_ADDRESS = tokenAddress;
    tokenDeployedByThisRun = true;
  }
  evidence.job.rewardToken = tokenAddress;
  persistEvidence();

  const tokenDecimals = await publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "decimals" });
  if (tokenDecimals !== 18) throw new DemoError(`Reward token decimals are ${tokenDecimals}; this acceptance run requires 18`);
  if (tokenDeployedByThisRun) {
    await sendAndConfirm("mint-demo-rewards", () => buyerWallet.writeContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: "mint",
      args: [buyer.address, totalReward],
    }));
  }
  const buyerTokenBalance = await publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [buyer.address] });
  if (buyerTokenBalance < totalReward) throw new DemoError("Buyer reward-token balance is below 10 tokens; job was not funded");

  const setter = encodeFunctionData({ abi: setterAbi, functionName: "setData", args: ["0x", jobKey, "0x"] });
  workerAGrantMayExist = true;
  await sendAndConfirm("grant-worker-a", () => buyerWallet.writeContract({ address: ensResolverAddress, abi: resolverAbi, functionName: "grantSetterRoles", args: [setter, workerAAddress] }));
  if (!(await authorityCheck(publicClient, adapterAddress, jobId, workerAAddress))) throw new DemoError("Worker A grant is not visible through JobAuthority");
  if (await authorityCheck(publicClient, adapterAddress, wrongJobId, workerAAddress)) throw new DemoError("Worker A grant leaked to a different job");
  evidence.assertions.push("Worker A job grant => authorized");
  evidence.assertions.push("Worker A wrong job => unauthorized");
  persistEvidence();

  workerBGrantMayExist = true;
  await sendAndConfirm("grant-worker-b", () => buyerWallet.writeContract({ address: ensResolverAddress, abi: resolverAbi, functionName: "grantSetterRoles", args: [setter, workerBAddress] }));
  if (!(await authorityCheck(publicClient, adapterAddress, jobId, workerBAddress))) throw new DemoError("Worker B grant is not visible through JobAuthority");
  if (await authorityCheck(publicClient, adapterAddress, wrongJobId, workerBAddress)) throw new DemoError("Worker B grant leaked to a different job");
  evidence.assertions.push("Worker B job grant => authorized");
  evidence.assertions.push("Worker B wrong job => unauthorized");
  persistEvidence();

  await sendAndConfirm("approve-escrow", () => buyerWallet.writeContract({ address: tokenAddress, abi: tokenAbi, functionName: "approve", args: [escrowAddress, totalReward] }));
  const allowance = await publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "allowance", args: [buyer.address, escrowAddress] });
  if (allowance < totalReward) throw new DemoError("Reward-token approval is below the 10-token job funding amount");

  await sendAndConfirm("fund-job", () => buyerWallet.writeContract({
    address: escrowAddress,
    abi: escrowAbi,
    functionName: "fundJob",
    args: [jobId, termsHash, taskId, tokenAddress, adapterAddress, buyer.address, cutoff, rewards, heads],
  }));
  const escrowFundedBalance = await publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [escrowAddress] });
  if (escrowFundedBalance !== totalReward) throw new DemoError("Escrow reward-token balance does not equal the 10-token funding amount");
  evidence.fundedTokenBalance = escrowFundedBalance.toString();
  evidence.assertions.push("funded three milestones: A=3, B=3+4");
  persistEvidence();

  await sendAndConfirm("assign-worker-a", () => buyerWallet.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: "assignTask", args: [jobId, workerAAddress] }));
  await sendAndConfirm("accept-a-milestone-1", () => buyerWallet.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: "acceptMilestone", args: [jobId, offerA, signatureA] }));
  const creditAAfterFirst = await publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "credits", args: [jobId, workerAAddress] });
  if (creditAAfterFirst !== rewards[0]) throw new DemoError("Worker A did not receive the first milestone credit of 3 tokens");
  evidence.assertions.push("A milestone 1 accepted and credited 3 tokens");
  persistEvidence();

  await sendAndConfirm("drain-for-takeover", () => buyerWallet.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: "drainTask", args: [jobId] }));
  await sendAndConfirm("takeover-by-worker-b", () => buyerWallet.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: "takeover", args: [jobId, takeoverAck, takeoverSignature] }));
  const jobAfterTakeover = await publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "jobs", args: [jobId] });
  if (getAddress(field(jobAfterTakeover, "assignedWorker", 10)) !== workerBAddress || BigInt(field(jobAfterTakeover, "epoch", 8)) !== 2n) {
    throw new DemoError("Escrow state did not transfer assignment to Worker B at epoch 2");
  }
  evidence.assertions.push("authority transferred to B at epoch 2");
  persistEvidence();

  await sendAndConfirm("revoke-worker-a", () => buyerWallet.writeContract({ address: ensResolverAddress, abi: resolverAbi, functionName: "revokeRoles", args: [resource, roleSetData, workerAAddress] }));
  workerAGrantMayExist = false;
  if (await authorityCheck(publicClient, adapterAddress, jobId, workerAAddress)) throw new DemoError("Worker A remains authorized after revoke");
  evidence.assertions.push("A scoped grant revoked after takeover");
  persistEvidence();

  let staleRejected = false;
  try {
    const staleCalldata = encodeFunctionData({ abi: escrowAbi, functionName: "acceptMilestone", args: [jobId, staleOfferA, staleSignatureA] });
    await publicClient.call({ account: buyer.address, to: escrowAddress, data: staleCalldata });
  } catch (error) {
    if (!isStaleEpochRevert(error, escrowAbi)) throw new DemoError("Stale A call reverted for a reason other than StaleEpoch; refusing to record stale-worker rejection");
    staleRejected = true;
  }
  if (!staleRejected) throw new DemoError("Stale A offer unexpectedly succeeded after takeover");
  evidence.assertions.push("stale A milestone offer rejected with StaleEpoch after B takeover");
  evidence.staleAttempt = { method: "eth_call", outcome: "reverted", error: "StaleEpoch" };
  persistEvidence();

  await sendAndConfirm("accept-b-milestone-2", () => buyerWallet.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: "acceptMilestone", args: [jobId, offerB1, signatureB1] }));
  await sendAndConfirm("accept-b-milestone-3", () => buyerWallet.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: "acceptMilestone", args: [jobId, offerB2, signatureB2] }));
  const creditA = await publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "credits", args: [jobId, workerAAddress] });
  const creditB = await publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "credits", args: [jobId, workerBAddress] });
  if (creditA !== 3n * tokenUnit || creditB !== 7n * tokenUnit) throw new DemoError("Final escrow credits did not equal A=3 and B=7 tokens");
  evidence.assertions.push("final immutable credits: A=3 tokens, B=7 tokens");
  persistEvidence();

  await sendAndConfirm("revoke-worker-b-after-completion", () => buyerWallet.writeContract({ address: ensResolverAddress, abi: resolverAbi, functionName: "revokeRoles", args: [resource, roleSetData, workerBAddress] }));
  workerBGrantMayExist = false;
  if (await authorityCheck(publicClient, adapterAddress, jobId, workerBAddress)) throw new DemoError("Worker B remains authorized after job completion revoke");
  await sendAndConfirm("close-completed-job", () => buyerWallet.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: "close", args: [jobId] }));
  const finalJob = await publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "jobs", args: [jobId] });
  if (!field(finalJob, "closed", 15) || BigInt(field(finalJob, "nextMilestone", 9)) !== 3n || BigInt(field(finalJob, "unallocated", 12)) !== 0n) {
    throw new DemoError("Completed job state or zero refund did not verify");
  }

  const workerABalanceBefore = await publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [workerAAddress] });
  const workerBBalanceBefore = await publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [workerBAddress] });
  await sendAndConfirm("claim-worker-a-3-tokens", () => workerAWallet.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: "claim", args: [jobId] }));
  await sendAndConfirm("claim-worker-b-7-tokens", () => workerBWallet.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: "claim", args: [jobId] }));
  const workerABalanceAfter = await publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [workerAAddress] });
  const workerBBalanceAfter = await publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [workerBAddress] });
  const workerAClaimed = await publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "claimed", args: [jobId, workerAAddress] });
  const workerBClaimed = await publicClient.readContract({ address: escrowAddress, abi: escrowAbi, functionName: "claimed", args: [jobId, workerBAddress] });
  if (workerABalanceAfter - workerABalanceBefore !== 3n * tokenUnit || !workerAClaimed) throw new DemoError("Worker A withdrawal did not increase its token balance by exactly 3 tokens");
  if (workerBBalanceAfter - workerBBalanceBefore !== 7n * tokenUnit || !workerBClaimed) throw new DemoError("Worker B withdrawal did not increase its token balance by exactly 7 tokens");
  const escrowTokenBalance = await publicClient.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [escrowAddress] });
  if (escrowTokenBalance !== 0n) throw new DemoError("Escrow retained reward tokens after both worker withdrawals");

  evidence.assertions.push("Worker A claimed exactly 3 tokens; Worker B claimed exactly 7 tokens");
  evidence.status = "LIVE_PASS";
  evidence.result = {
    workerAWithdrawal: { amount: (3n * tokenUnit).toString(), balanceBefore: workerABalanceBefore.toString(), balanceAfter: workerABalanceAfter.toString(), claimed: workerAClaimed },
    workerBWithdrawal: { amount: (7n * tokenUnit).toString(), balanceBefore: workerBBalanceBefore.toString(), balanceAfter: workerBBalanceAfter.toString(), claimed: workerBClaimed },
    escrowRewardBalanceAfterClaims: escrowTokenBalance.toString(),
  };
  persistEvidence();
  console.log(JSON.stringify({ stage: "verified", network: "Sepolia", chainId, escrowAddress, tokenAddress, adapterAddress, ensResolverAddress, workerA: workerAAddress, workerB: workerBAddress, jobId, credits: { workerA: "3", workerB: "7" }, evidencePath: relativePath(evidencePath) }));
} catch (error) {
  if (evidence) {
    evidence.status = "INCOMPLETE";
    evidence.failureCode = safeErrorCode(error);
    persistEvidence();
  }
  if (error instanceof DemoError) console.error(`[demo:sepolia:job-lifecycle] ${error.message}`);
  else console.error(`[demo:sepolia:job-lifecycle] Workflow stopped (${safeErrorCode(error)}). RPC URLs and private keys were not printed.`);
  process.exitCode = 1;
} finally {
  if (publicClient && ensResolverAddress && resource && jobId) {
    await cleanupScopedGrant("Worker A", workerAAddress, () => workerAGrantMayExist, (value) => { workerAGrantMayExist = value; });
    await cleanupScopedGrant("Worker B", workerBAddress, () => workerBGrantMayExist, (value) => { workerBGrantMayExist = value; });
  }
}

function requireSetting(name) {
  if (!env[name]) throw new DemoError(`${name} is missing from local .env`);
}

function accountFromEnv(name, fallbackName) {
  const value = env[name] || (fallbackName ? env[fallbackName] : "");
  if (!value) throw new DemoError(`${name} is missing from local .env; set it locally and never paste it in chat`);
  try {
    return privateKeyToAccount(value.startsWith("0x") ? value : `0x${value}`);
  } catch {
    throw new DemoError(`${name} is malformed; correct it in local .env`);
  }
}

function checksumSetting(name) {
  try {
    return getAddress(env[name]);
  } catch {
    throw new DemoError(`${name} is malformed; correct the public address in local .env`);
  }
}

function makeOffer({ jobId, taskId, termsHash, producer, epoch, milestone, expectedHead, newHead, expiry }) {
  return { jobId, taskId, termsHash, producer, epoch, milestone, expectedHead, newHead, nonce: randomNonce(), expiry };
}

function randomNonce() {
  return BigInt(`0x${randomBytes(32).toString("hex")}`);
}

function hashText(value) {
  return keccak256(stringToHex(value));
}

async function requireCode(client, address, label) {
  const code = await client.getBytecode({ address });
  if (!code || code === "0x") throw new DemoError(`${label} has no deployed code on Sepolia`);
  return code;
}

async function authorityCheck(client, adapter, targetJobId, worker) {
  return client.readContract({ address: adapter, abi: adapterAbi, functionName: "hasWorkerGrant", args: [targetJobId, worker] });
}

async function sendAndConfirm(label, send) {
  const hash = await send();
  evidence.transactions[label] = hash;
  persistEvidence();
  console.log(JSON.stringify({ stage: "submitted", action: label, transactionHash: hash }));
  const confirmations = Math.max(1, Number(env.CONFIRMATION_BLOCKS ?? 2));
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations, timeout: 240_000 });
  if (receipt.status !== "success") throw new DemoError(`${label} transaction ${hash} reverted`);
  evidence.receipts ??= {};
  evidence.receipts[label] = { status: receipt.status, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), confirmations };
  persistEvidence();
  console.log(JSON.stringify({ stage: "confirmed", action: label, blockNumber: receipt.blockNumber.toString(), confirmations }));
  return { hash, receipt };
}

function field(struct, name, index) {
  return struct?.[name] ?? struct?.[index];
}

function isStaleEpochRevert(error, abi) {
  const queue = [error];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (typeof current === "string") {
      if (current.includes("StaleEpoch")) return true;
      continue;
    }
    if (typeof current !== "object") continue;
    if (current.name === "StaleEpoch" || String(current.shortMessage ?? "").includes("StaleEpoch") || String(current.message ?? "").includes("StaleEpoch")) return true;
    for (const value of [current.data, current.cause, current.error, current.details]) {
      if (typeof value === "string" && /^0x[0-9a-fA-F]{8,}$/.test(value)) {
        try {
          const decoded = decodeErrorResult({ abi, data: value });
          if (decoded.errorName === "StaleEpoch") return true;
        } catch {}
      } else if (value && typeof value === "object") queue.push(value);
    }
  }
  return false;
}

async function cleanupScopedGrant(label, address, getMaybeExists, setMaybeExists) {
  if (!getMaybeExists() || !address) return;
  try {
    const bitmap = await publicClient.readContract({ address: ensResolverAddress, abi: resolverAbi, functionName: "roles", args: [resource, address] });
    if ((bitmap & roleSetData) !== 0n) {
      const hash = await buyerWallet.writeContract({ address: ensResolverAddress, abi: resolverAbi, functionName: "revokeRoles", args: [resource, roleSetData, address] });
      const confirmations = Math.max(1, Number(env.CONFIRMATION_BLOCKS ?? 2));
      await publicClient.waitForTransactionReceipt({ hash, confirmations, timeout: 240_000 });
      evidence?.transactions && (evidence.transactions[`cleanup-revoke-${label.toLowerCase().replaceAll(" ", "-")}`] = hash);
      persistEvidence();
      console.log(JSON.stringify({ stage: "cleanup-revoked", worker: label, transactionHash: hash }));
    }
    setMaybeExists(false);
  } catch (error) {
    console.error(JSON.stringify({ stage: "cleanup-warning", worker: label, code: safeErrorCode(error) }));
  }
}

function saveEnvField(name, value) {
  const expression = new RegExp(`^${name}=.*$`, "m");
  envText = expression.test(envText) ? envText.replace(expression, `${name}=${value}`) : `${envText.replace(/\s*$/, "")}\n${name}=${value}\n`;
  const temporaryPath = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, envText, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, envPath);
  chmodSync(envPath, 0o600);
}

function persistEvidence() {
  if (!evidencePath || !evidence) return;
  mkdirSync(dirname(evidencePath), { recursive: true });
  const temporaryPath = `${evidencePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, evidencePath);
  chmodSync(evidencePath, 0o600);
}

function relativePath(path) {
  return path.replace(`${root}/`, "");
}

function safeErrorCode(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.code) return current.code;
  }
  return error?.name ?? "Error";
}
