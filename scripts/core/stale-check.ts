// Stale-worker boundary check. Run with the *replaced* worker's own env file, after takeover:
//   node --env-file=.env.worker-a --import tsx scripts/core/stale-check.ts <jobId>
// It attempts protected actions as that worker and expects every one to be refused.
// Uses eth_call simulation only; it never submits a transaction.
import { randomBytes } from "node:crypto";
import { createPublicClient, encodeFunctionData, getAddress, http, type Address, type Hex } from "viem";
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
await expectRefusal("escrow: acceptMilestone(stale offer) simulated as buyer", () => client.call({ account: getAddress(String(chainJob[0])), to: job.escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: "acceptMilestone", args: [jobId, offer, signature] }) }));
const report = { jobId, staleWorker: account.address, chainAssigned: chainJob[10], chainEpoch: currentEpoch, results, allRefused: results.every((r) => r.refused) };
console.log(JSON.stringify(report, null, 2));
process.exit(report.allRefused ? 0 : 1);
