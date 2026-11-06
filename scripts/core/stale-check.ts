// Stale-worker boundary check. Run with the *replaced* worker's own env file, after takeover:
//   node --env-file=.env.worker-a --import tsx scripts/core/stale-check.ts <jobId>
// It attempts protected actions as that worker and expects every one to be refused.
// Uses eth_call simulation and refused API requests only; it never submits a transaction.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BaseError, ContractFunctionRevertedError, createPublicClient, getAddress, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { HttpCheckpointKeyGrantResolver } from "../../server/packages/storage/src/httpKeyGrantResolver.js";
import { BATON_DOMAIN, OFFER_TYPES } from "../../server/src/chain/signing.js";
import { escrowAbi, writerBinding } from "../../server/src/services/core/coreService.js";
import { workerRequestMessage } from "../../server/src/services/orchestrator/workerAuth.js";

const jobId = process.argv[2] as Hex;
const e = process.env;
const workerId = e.BATON_WORKER_ID ?? "a";
const account = privateKeyToAccount(e.WORKER_EVM_PRIVATE_KEY as Hex);
const api = (e.BATON_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const client = createPublicClient({ chain: sepolia, transport: http(e.SEPOLIA_RPC_URL) });
const keys = new HttpCheckpointKeyGrantResolver(e.CHECKPOINT_KEY_SERVICE_URL!, e.CHECKPOINT_KEY_SERVICE_TOKEN!, e.CHECKPOINT_KEY_SERVICE_DECRYPTION_PRIVATE_KEY!);
const job = await fetch(`${api}/api/core/jobs/${jobId}`).then((r) => r.json()) as { taskId: Hex; termsHash: Hex; escrow: Address; acceptanceSpecHashes: Hex[]; checkpoints: Array<{ manifestDigest: Hex; keyId: string; status: string }>; contentKeys: Record<string, { keyId: string }> };
const chainJob = await client.readContract({ address: job.escrow, abi: escrowAbi, functionName: "jobs", args: [jobId] });
const results: Array<{ action: string; refused: boolean; detail: string }> = [];
const expectRefusal = async (action: string, attempt: () => Promise<unknown>) => {
  try {
    await attempt();
    results.push({ action, refused: false, detail: "ACCEPTED (unexpected)" });
  } catch (error) {
    results.push({ action, refused: true, detail: (error as Error).message.split("\n")[0]!.slice(0, 160) });
  }
};

const signed = async (method: "GET" | "POST", path: string, body?: unknown) => {
  const text = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await account.signMessage({ message: workerRequestMessage({ workerId, method, path, timestamp, body: text }) });
  const response = await fetch(api + path, { method, headers: { "content-type": "application/json", "x-baton-worker-id": workerId, "x-baton-timestamp": String(timestamp), "x-baton-signature": signature }, body: method === "POST" ? text : undefined });
  if (!response.ok) throw new Error(`${response.status} ${(await response.json().catch(() => ({}))).error ?? ""}`);
  return response.json();
};

const currentEpoch = Number(chainJob[8]);
for (const epoch of [1, currentEpoch]) {
  const keyId = job.contentKeys[String(epoch)]?.keyId;
  if (keyId) await expectRefusal(`key-service: epoch-${epoch} writer key`, () => keys.resolveGrantedKey({ jobId, taskId: job.taskId, manifestDigest: writerBinding(jobId, epoch), keyId, worker: account.address }));
}
for (const cp of job.checkpoints.filter((c) => c.status === "accepted")) {
  await expectRefusal(`key-service: accepted checkpoint ${cp.manifestDigest.slice(0, 10)}`, () => keys.resolveGrantedKey({ jobId, taskId: job.taskId, manifestDigest: cp.manifestDigest, keyId: cp.keyId, worker: account.address }));
}
await expectRefusal("API: worker-context", () => signed("GET", `/api/core/jobs/${jobId}/worker-context`));
const milestone = Number(chainJob[9]);
const offer = {
  jobId, taskId: job.taskId, termsHash: job.termsHash, producer: account.address, epoch: 1n, milestone,
  acceptanceSpecHash: job.acceptanceSpecHashes[milestone] ?? job.acceptanceSpecHashes[0]!, expectedHead: chainJob[11], newHead: `0x${randomBytes(32).toString("hex")}` as Hex,
  manifestRef: `0x${randomBytes(32).toString("hex")}`, sequence: 99n, nonce: BigInt(`0x${randomBytes(16).toString("hex")}`), expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
};
const signature = await account.signTypedData({ domain: { ...BATON_DOMAIN, chainId: 11155111, verifyingContract: job.escrow }, types: OFFER_TYPES, primaryType: "MilestoneOffer", message: offer });
await expectRefusal("API: submit stale milestone offer", () => signed("POST", `/api/core/jobs/${jobId}/offers`, { offer: Object.fromEntries(Object.entries(offer).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])), signature, keyId: "stale" }));
// On-chain refusals must decode to the specific expected custom error, so an unrelated revert cannot pass.
const fullAbi = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../server/contracts/abi/JobEscrow.json"), "utf8")) as Abi;
const expectRevert = async (action: string, from: Address, functionName: string, args: unknown[], expected: string[]) => {
  try {
    await client.simulateContract({ account: from, address: job.escrow, abi: fullAbi, functionName, args } as never);
    results.push({ action, refused: false, detail: "ACCEPTED (unexpected)" });
  } catch (error) {
    const reverted = (error as BaseError).walk?.((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | undefined;
    const name = reverted?.data?.errorName ?? "UNDECODED";
    results.push({ action, refused: expected.includes(name), detail: `${name} (expected ${expected.join("|")})` });
  }
};
const closed = Boolean(chainJob[15]);
await expectRevert("escrow: buyer submitting A's stale offer", getAddress(String(chainJob[0])), "acceptMilestone", [jobId, offer, signature], closed ? ["NotOpen"] : ["StaleEpoch"]);
await expectRevert("escrow: A submitting its own offer", account.address, "acceptMilestone", [jobId, offer, signature], ["NotOpen"]);
await expectRevert("escrow: A draining the job", account.address, "drainTask", [jobId], ["Unauthorized"]);
await expectRevert("escrow: A pausing the job", account.address, "pause", [jobId], ["Unauthorized"]);
// Unauthenticated or forged API requests.
const unauth = async (action: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  results.push({ action, refused: response.status === 401, detail: `HTTP ${response.status}` });
};
await unauth("API: accept milestone without buyer token", `/api/core/jobs/${jobId}/milestones/${milestone + 1}/accept`, {});
await unauth("API: takeover without buyer token", `/api/core/jobs/${jobId}/takeover`, { workerId: workerId });
await unauth("API: takeover with wrong buyer token", `/api/core/jobs/${jobId}/takeover`, { workerId: workerId }, { "x-baton-buyer-token": "x".repeat(43) });
await unauth("API: stop worker without buyer token", "/api/core/workers/b/stop", {});
await unauth("API: submit job without buyer token", "/api/core/jobs", {});
const forgedBody = JSON.stringify({});
const forgedAt = Math.floor(Date.now() / 1000);
const forgedSig = await account.signMessage({ message: workerRequestMessage({ workerId: "b", method: "POST", path: "/api/workers/b/heartbeat", timestamp: forgedAt, body: forgedBody }) });
await unauth("API: A impersonating worker b", "/api/workers/b/heartbeat", {}, { "x-baton-worker-id": "b", "x-baton-timestamp": String(forgedAt), "x-baton-signature": forgedSig });
const report = { jobId, staleWorker: account.address, chainAssigned: chainJob[10], chainEpoch: currentEpoch, results, allRefused: results.every((r) => r.refused) };
console.log(JSON.stringify(report, null, 2));
process.exit(report.allRefused ? 0 : 1);
