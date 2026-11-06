import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { keccak256, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encryptManifest, decryptManifest, CHECKPOINT_SCHEMA_VERSION, type CheckpointManifest } from "../../../packages/checkpoint/src/index.js";
import { generateCheckpointKeyRecipientPair } from "../../../packages/storage/src/keyGrantCrypto.js";
import { CheckpointKeyGrantStore, generateWorkerAccessToken } from "../key-service/store.js";
import { buildIncidentTriageSpec, checkMilestone } from "../orchestrator/taskTemplate.js";
import { validateRecoveredManifest } from "../orchestrator/recoveryValidation.js";
import { verifyWorkerRequest, workerRequestMessage } from "../orchestrator/workerAuth.js";
import { JournaledChain, type JournalWallet } from "./chainOps.js";
import { CoreStore } from "./coreStore.js";
import { writerBinding } from "./coreService.js";

const buyerKey = generatePrivateKey();

function fakeChain(options: { failFirstBroadcast?: boolean } = {}) {
  const calls = { prepared: 0, signed: 0, broadcasts: [] as Hex[] };
  let mined: Hex | undefined;
  let failNext = options.failFirstBroadcast ?? false;
  const publicClient = {
    call: async () => ({ data: "0x" }),
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      calls.broadcasts.push(serializedTransaction);
      if (failNext) {
        failNext = false;
        throw new Error("socket hang up");
      }
      mined = keccak256(serializedTransaction);
      return mined;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash !== mined) throw new Error("not found");
      return { status: "success", blockNumber: 10n, gasUsed: 21000n, logs: [] };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (hash !== mined) throw new Error("not found");
      return {};
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash !== mined) throw new Error("timeout");
      return { status: "success", blockNumber: 10n, gasUsed: 21000n, logs: [] };
    },
  } as unknown as PublicClient;
  const walletClient: JournalWallet = {
    prepareTransactionRequest: async () => {
      calls.prepared += 1;
      return {};
    },
    signTransaction: async () => {
      calls.signed += 1;
      return `0x02${calls.signed.toString(16).padStart(8, "0")}` as Hex;
    },
  };
  return { publicClient, walletClient, calls };
}

test("journal: a crash after signing reconciles the recorded transaction instead of sending a new one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baton-core-"));
  const store = new CoreStore(join(dir, "state.json"));
  const fake = fakeChain({ failFirstBroadcast: true });
  const chain = new JournaledChain(store, "http://unused", buyerKey, 1, fake);
  chain.simulationRetryMs = 1;
  const build = async () => ({ to: "0x0000000000000000000000000000000000000001" as Hex, data: "0x" as Hex });
  await assert.rejects(chain.run({}, "escrow:fund", "fund", build), /socket hang up/);
  const pending = await chain.getOp({}, "escrow:fund");
  assert.equal(pending?.status, "submitted");
  assert.ok(pending?.rawTx && pending.txHash);
  // Simulated service restart: a fresh store instance reloads the journal from disk.
  const restarted = new JournaledChain(new CoreStore(join(dir, "state.json")), "http://unused", buyerKey, 1, fake);
  const op = await restarted.run({}, "escrow:fund", "fund", build);
  assert.equal(op.status, "confirmed");
  assert.equal(fake.calls.signed, 1, "no second funding transaction was signed");
  assert.deepEqual(fake.calls.broadcasts, [pending!.rawTx, pending!.rawTx], "only the identical raw transaction is rebroadcast");
  // Further retries are no-ops.
  await restarted.run({}, "escrow:fund", "fund", build);
  assert.equal(fake.calls.signed, 1);
});

test("journal: state already present on-chain is not written again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baton-core-"));
  const fake = fakeChain();
  const chain = new JournaledChain(new CoreStore(join(dir, "state.json")), "http://unused", buyerKey, 1, fake);
  const op = await chain.run({}, "escrow:assign:1", "assign", async () => ({ data: "0x" as Hex }), { alreadyDone: async () => ({ assigned: true }) });
  assert.equal(op.status, "skipped");
  assert.equal(fake.calls.signed, 0);
});

test("acceptance: a successor that ignores the recovered clusters fails milestone 2", () => {
  const spec = buildIncidentTriageSpec("seed-1");
  const ids = spec.input.content.trim().split("\n").map((line) => line.split(" ")[0]!);
  const normalized = JSON.stringify(ids.map((id) => ({ id, timestamp: "t", service: "s", severity: "ERROR", message: "m" })));
  const third = Math.ceil(ids.length / 3);
  const clusters = { clusters: [0, 1, 2].map((i) => ({ clusterId: `C${i + 1}`, title: `c${i}`, incidentIds: ids.slice(i * third, (i + 1) * third) })) };
  const files: Record<string, string> = { "normalized.json": normalized, "clusters.json": JSON.stringify(clusters) };
  assert.equal(checkMilestone(spec, 1, files).ok, true);
  const analysis = (clusterIds: string[]) => JSON.stringify({ analyses: clusterIds.map((clusterId, i) => ({ clusterId, rootCause: "connection pool exhaustion on the primary database", impact: "x", evidence: clusters.clusters[i]?.incidentIds.slice(0, 1) ?? ["INC-999"], confidence: 0.7 })) });
  assert.equal(checkMilestone(spec, 2, { ...files, "analysis.json": analysis(["C1", "C2", "C3"]) }).ok, true);
  assert.equal(checkMilestone(spec, 2, { ...files, "analysis.json": analysis(["C1", "C2", "C3", "C4"]) }).ok, false);
  assert.equal(checkMilestone(spec, 2, { "analysis.json": analysis(["C1", "C2", "C3"]) }).ok, false, "missing recovered outputs fail");
});

function manifest(overrides: Partial<CheckpointManifest> = {}): CheckpointManifest {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    jobId: "0xjob",
    taskId: "0xtask",
    epoch: 1,
    sequence: 1,
    previousAcceptedHead: null,
    createdAt: new Date().toISOString(),
    adapter: { id: "codex-app-server", version: "1", stateSchemaVersion: "baton.codex-worker.v1" },
    work: { objective: "o", constraints: [], completed: [], decisions: [], unresolved: ["m2"], nextActions: [] },
    artifacts: [],
    tools: [],
    externalOperations: [],
    runtimeState: { writer: privateKeyToAccount(generatePrivateKey()).address },
    ...overrides,
  };
}

test("recovery: an earlier-epoch checkpoint stays valid after takeover; wrong job, epoch, sequence are rejected", () => {
  const expected = { jobId: "0xjob", taskId: "0xtask", acceptedSequence: 1, currentEpoch: 2 };
  assert.ok(validateRecoveredManifest(manifest({ epoch: 1 }), expected).writer);
  assert.throws(() => validateRecoveredManifest(manifest({ jobId: "0xother" }), expected), /RECOVERY_WRONG_JOB/);
  assert.throws(() => validateRecoveredManifest(manifest({ epoch: 3 }), expected), /RECOVERY_EPOCH_INVALID/);
  assert.throws(() => validateRecoveredManifest(manifest({ epoch: 0 }), expected), /RECOVERY_EPOCH_INVALID/);
  assert.throws(() => validateRecoveredManifest(manifest({ sequence: 2 }), expected), /RECOVERY_SEQUENCE_MISMATCH/);
  assert.throws(() => validateRecoveredManifest(manifest({ runtimeState: {} }), expected), /RECOVERY_WRITER_MISSING/);
});

test("recovery: altered or corrupted encrypted checkpoints fail authentication", () => {
  const key = `0x${"11".repeat(32)}`;
  const envelope = encryptManifest(manifest(), key, "k1");
  assert.equal(decryptManifest(envelope, key).jobId, "0xjob");
  const flipped = envelope.ciphertext.startsWith("A") ? `B${envelope.ciphertext.slice(1)}` : `A${envelope.ciphertext.slice(1)}`;
  assert.throws(() => decryptManifest({ ...envelope, ciphertext: flipped }, key));
  assert.throws(() => decryptManifest({ ...envelope, jobId: "0xother" }, key), "job binding is authenticated");
  assert.throws(() => decryptManifest(envelope, `0x${"22".repeat(32)}`), "wrong key fails");
});

test("key service: revocation blocks the stale worker's future key access without affecting the successor", () => {
  const store = new CheckpointKeyGrantStore(":memory:", `0x${"33".repeat(32)}`);
  const a = privateKeyToAccount(generatePrivateKey()).address;
  const b = privateKeyToAccount(generatePrivateKey()).address;
  const tokenA = generateWorkerAccessToken();
  const tokenB = generateWorkerAccessToken();
  store.replaceWorkerToken(a, tokenA, generateCheckpointKeyRecipientPair().publicKey);
  store.replaceWorkerToken(b, tokenB, generateCheckpointKeyRecipientPair().publicKey);
  const jobId = `0x${"ab".repeat(32)}` as Hex;
  const head = `0x${"cd".repeat(32)}` as Hex;
  const key = `0x${"44".repeat(32)}`;
  store.grantKey({ jobId, taskId: "t", manifestDigest: writerBinding(jobId, 1), keyId: "e1", worker: a }, key);
  store.grantKey({ jobId, taskId: "t", manifestDigest: head, keyId: "e1", worker: b }, key);
  assert.ok(store.resolve(tokenA, { jobId, taskId: "t", manifestDigest: writerBinding(jobId, 1), keyId: "e1", worker: a }));
  assert.equal(store.revokeWorkerGrants(jobId, a), 1);
  assert.throws(() => store.resolve(tokenA, { jobId, taskId: "t", manifestDigest: writerBinding(jobId, 1), keyId: "e1", worker: a }), /KEY_GRANT_NOT_FOUND/);
  assert.throws(() => store.resolve(tokenA, { jobId, taskId: "t", manifestDigest: head, keyId: "e1", worker: b }), /WORKER_SUBJECT_MISMATCH/, "A cannot use B's grant");
  assert.throws(() => store.resolve("x".repeat(43), { jobId, taskId: "t", manifestDigest: head, keyId: "e1", worker: b }), /UNAUTHORIZED/);
  assert.ok(store.resolve(tokenB, { jobId, taskId: "t", manifestDigest: head, keyId: "e1", worker: b }), "B's recovery grant for A's checkpoint survives");
  store.close();
});

test("worker auth: signatures bind worker, path, time and body", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const now = Math.floor(Date.now() / 1000);
  const base = { workerId: "a", method: "POST", path: "/api/core/jobs/x/offers", timestamp: now, body: '{"m":1}' };
  const signature = await account.signMessage({ message: workerRequestMessage(base) });
  assert.equal(await verifyWorkerRequest({ ...base, expectedAddress: account.address, signature }), true);
  assert.equal(await verifyWorkerRequest({ ...base, body: '{"m":2}', expectedAddress: account.address, signature }), false);
  assert.equal(await verifyWorkerRequest({ ...base, path: "/api/other", expectedAddress: account.address, signature }), false);
  assert.equal(await verifyWorkerRequest({ ...base, expectedAddress: privateKeyToAccount(generatePrivateKey()).address, signature }), false);
  assert.equal(await verifyWorkerRequest({ ...base, expectedAddress: account.address, signature, nowSeconds: now + 3600 }), false);
});

test("store: job mappings survive a service restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baton-core-"));
  const first = new CoreStore(join(dir, "state.json"));
  await first.mutate((s) => {
    s.workers.a = { workerId: "a", address: "0x0000000000000000000000000000000000000001", walletVerifiedAt: "t", runtime: { kind: "codex-app-server" }, capabilities: [], connection: "available", events: [] };
  });
  const second = new CoreStore(join(dir, "state.json"));
  assert.equal((await second.read((s) => s.workers.a))?.address, "0x0000000000000000000000000000000000000001");
});

test("journal: a lagging simulation is retried before the operation fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baton-core-"));
  const fake = fakeChain();
  let calls = 0;
  (fake.publicClient as unknown as { call: () => Promise<unknown> }).call = async () => {
    calls += 1;
    if (calls < 3) throw new Error("execution reverted");
    return { data: "0x" };
  };
  const chain = new JournaledChain(new CoreStore(join(dir, "state.json")), "http://unused", buyerKey, 1, fake);
  chain.simulationRetryMs = 1;
  const op = await chain.run({}, "escrow:assign:1", "assign", async () => ({ data: "0x" as Hex }));
  assert.equal(op.status, "confirmed");
  assert.equal(calls, 3);
  assert.equal(fake.calls.signed, 1);
});
