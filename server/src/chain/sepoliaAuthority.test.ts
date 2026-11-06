import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, stringToHex, type Hex } from "viem";
import { SepoliaAuthorityReader, type ChainAdmission } from "./sepoliaAuthority.js";
import { JobStore } from "../domain/jobs/jobStore.js";
import { EMPTY_HEAD, type JobSnapshot } from "../protocol/v1.js";

const buyer = address("1");
const token = address("2");
const adapter = address("3");
const verifier = address("4");
const worker = address("5");
const escrow = address("6");
const chainJobId = digest("1");
const chainTaskId = digest("2");
const termsHash = digest("3");
const acceptedHead = digest("4");
const manifestRef = "arkiv://accepted-head-1";
const blockHash = digest("5");
const blockNumber = 100n;

test("authority reader evaluates all job bindings at one confirmed block and records its hash", async () => {
  const calls: Array<{ functionName: string; blockNumber?: bigint }> = [];
  const client = fakeClient({ calls });
  const reader = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    confirmationBlocks: 2,
    client,
  });

  await reader.assertCurrentWorker(admission());

  assert.deepEqual(calls.map((call) => call.functionName).sort(), [
    "PROTOCOL_VERSION",
    "acceptedCheckpoint",
    "hasWorkerGrant",
    "jobs",
  ].sort());
  assert(calls.every((call) => call.blockNumber === blockNumber - 2n));
  assert.deepEqual(reader.lastConfirmedRead, {
    blockNumber: blockNumber - 2n,
    blockHash,
    confirmationBlocks: 2,
  });
});

test("authority reader fails closed on a reorg, wrong job binding, or revoked grant", async () => {
  const reorgReader = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    confirmationBlocks: 0,
    client: fakeClient({ afterHash: digest("6") }),
  });
  await assert.rejects(reorgReader.assertCurrentWorker(admission()), /CHAIN_STATE_REORGED/);
  assert.equal(reorgReader.lastConfirmedRead, undefined);

  const mismatchedReader = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    client: fakeClient({ taskId: digest("7") }),
  });
  await assert.rejects(mismatchedReader.assertCurrentWorker(admission()), /ONCHAIN_TASK_MISMATCH/);

  const revokedReader = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    client: fakeClient({ granted: false }),
  });
  await assert.rejects(revokedReader.assertCurrentWorker(admission()), /WORKER_AUTHORITY_REVOKED/);
});

test("authority reader rejects a non-Sepolia chain before reading escrow state", async () => {
  const calls: Array<{ functionName: string; blockNumber?: bigint }> = [];
  const reader = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    client: fakeClient({ calls, chainId: 1 }),
  });
  await assert.rejects(reader.assertCurrentWorker(admission()), /CHAIN_NETWORK_MISMATCH/);
  assert.deepEqual(calls, []);
});

test("authority reader compares independent RPCs at one shared confirmed block", async () => {
  const primaryCalls: Array<{ functionName: string; blockNumber?: bigint }> = [];
  const witnessCalls: Array<{ functionName: string; blockNumber?: bigint }> = [];
  const reader = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    confirmationBlocks: 2,
    maxRpcHeadLagBlocks: 2,
    client: fakeClient({ calls: primaryCalls, latestBlock: 102n }),
    additionalClients: [fakeClient({ calls: witnessCalls, latestBlock: 101n })],
  });

  await reader.assertCurrentWorker(admission());

  assert(primaryCalls.every((call) => call.blockNumber === 99n));
  assert(witnessCalls.every((call) => call.blockNumber === 99n));
  assert.equal(reader.lastConfirmedRead?.blockNumber, 99n);
});

test("authority reader fails closed when RPC block hashes or contract state disagree", async () => {
  const headLag = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    maxRpcHeadLagBlocks: 2,
    client: fakeClient({ latestBlock: 100n }),
    additionalClients: [fakeClient({ latestBlock: 97n })],
  });
  await assert.rejects(headLag.assertCurrentWorker(admission()), /CHAIN_RPC_DISAGREEMENT/);
  assert.equal(headLag.lastConfirmedRead, undefined);

  const hashDisagreement = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    client: fakeClient(),
    additionalClients: [fakeClient({ blockHash: digest("6") })],
  });
  await assert.rejects(hashDisagreement.assertCurrentWorker(admission()), /CHAIN_RPC_DISAGREEMENT/);
  assert.equal(hashDisagreement.lastConfirmedRead, undefined);

  const stateDisagreement = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    client: fakeClient(),
    additionalClients: [fakeClient({ granted: false })],
  });
  await assert.rejects(stateDisagreement.assertCurrentWorker(admission()), /CHAIN_RPC_DISAGREEMENT/);
  assert.equal(stateDisagreement.lastConfirmedRead, undefined);
});

test("authority reader imports only a pristine funded job at one confirmed block", async () => {
  const snapshot = importSnapshot();
  const calls: Array<{ functionName: string; blockNumber?: bigint }> = [];
  const cutoff = BigInt(snapshot.terms.cutoff);
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const client = fakeClient({
    calls,
    buyer: snapshot.terms.buyer as Hex,
    rewardToken: snapshot.terms.rewardToken as Hex,
    verifier: snapshot.terms.verifier as Hex,
    termsHash: snapshot.terms.termsHash,
    taskId: snapshot.chainTaskId,
    rewardPool: 7n,
    cutoff,
    epoch: 0n,
    nextMilestone: 0n,
    assignedWorker: address("0"),
    acceptedHead: EMPTY_HEAD as Hex,
    acceptedSequence: 0n,
    acceptedManifestRef: "",
    unallocated: 7n,
    milestoneCount: 2n,
    blockTimestamp: timestamp,
    totalCredited: 0n,
  });
  const reader = new SepoliaAuthorityReader({ escrowAddress: escrow, adapterAddress: adapter, confirmationBlocks: 1, client });

  await reader.assertImportableJob(snapshot);

  assert.deepEqual(calls.map((call) => call.functionName).sort(), [
    "PROTOCOL_VERSION",
    "acceptedCheckpoint",
    "jobs",
    "milestoneCount",
  ].sort());
  assert(calls.every((call) => call.blockNumber === blockNumber - 1n));

  const alreadyAssignedReader = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    client: fakeClient({
      buyer: snapshot.terms.buyer as Hex,
      rewardToken: snapshot.terms.rewardToken as Hex,
      verifier: snapshot.terms.verifier as Hex,
      termsHash: snapshot.terms.termsHash,
      taskId: snapshot.chainTaskId,
      rewardPool: 7n,
      cutoff,
      epoch: 1n,
      nextMilestone: 0n,
      assignedWorker: worker,
      acceptedHead: EMPTY_HEAD as Hex,
      acceptedSequence: 0n,
      acceptedManifestRef: "",
      unallocated: 7n,
      milestoneCount: 2n,
      blockTimestamp: timestamp,
      totalCredited: 0n,
    }),
  });
  await assert.rejects(alreadyAssignedReader.assertImportableJob(snapshot), /ONCHAIN_JOB_NOT_IMPORTABLE/);
});

test("authority reader validates a local accepted-head snapshot before key administration", async () => {
  const snapshot = importSnapshot();
  snapshot.task.assignedWorker = worker;
  snapshot.task.epoch = 2;
  snapshot.task.nextMilestone = 1;
  snapshot.task.acceptedHead = {
    manifestDigest: acceptedHead,
    manifestRef,
    artifactManifestDigest: digest("8"),
    schemaVersion: "checkpoint.v1",
    sequence: 1,
    previousAcceptedHead: null,
  };
  snapshot.credits.push({ id: "credit-1", worker, milestoneId: "milestone-1", amount: 3n, claimed: false });
  const reader = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    client: fakeClient({
      buyer: snapshot.terms.buyer as Hex,
      rewardToken: snapshot.terms.rewardToken as Hex,
      verifier: snapshot.terms.verifier as Hex,
      termsHash: snapshot.terms.termsHash,
      taskId: snapshot.chainTaskId,
      rewardPool: 7n,
      cutoff: BigInt(snapshot.terms.cutoff),
      epoch: 2n,
      nextMilestone: 1n,
      assignedWorker: worker,
      acceptedHead,
      acceptedSequence: 1n,
      acceptedManifestRef: manifestRef,
      unallocated: 4n,
      totalCredited: 3n,
    }),
  });
  await reader.assertSnapshotCurrent(snapshot);

  const accountingMismatchReader = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    client: fakeClient({
      buyer: snapshot.terms.buyer as Hex,
      rewardToken: snapshot.terms.rewardToken as Hex,
      verifier: snapshot.terms.verifier as Hex,
      termsHash: snapshot.terms.termsHash,
      taskId: snapshot.chainTaskId,
      rewardPool: 7n,
      cutoff: BigInt(snapshot.terms.cutoff),
      epoch: 2n,
      nextMilestone: 1n,
      assignedWorker: worker,
      acceptedHead,
      acceptedSequence: 1n,
      acceptedManifestRef: manifestRef,
      unallocated: 3n,
      totalCredited: 3n,
    }),
  });
  await assert.rejects(accountingMismatchReader.assertSnapshotCurrent(snapshot), /ONCHAIN_JOB_ACCOUNTING_MISMATCH/);

  const staleReader = new SepoliaAuthorityReader({
    escrowAddress: escrow,
    adapterAddress: adapter,
    client: fakeClient({
      buyer: snapshot.terms.buyer as Hex,
      rewardToken: snapshot.terms.rewardToken as Hex,
      verifier: snapshot.terms.verifier as Hex,
      termsHash: snapshot.terms.termsHash,
      taskId: snapshot.chainTaskId,
      cutoff: BigInt(snapshot.terms.cutoff),
      acceptedHead: digest("9"),
      acceptedSequence: 1n,
      acceptedManifestRef: manifestRef,
      epoch: 2n,
      nextMilestone: 1n,
      assignedWorker: worker,
    }),
  });
  await assert.rejects(staleReader.assertSnapshotCurrent(snapshot), /ONCHAIN_HEAD_MISMATCH/);
});

function fakeClient(options: {
  calls?: Array<{ functionName: string; blockNumber?: bigint }>;
  afterHash?: Hex;
  taskId?: Hex;
  granted?: boolean;
  chainId?: number;
  buyer?: Hex;
  rewardToken?: Hex;
  verifier?: Hex;
  termsHash?: Hex;
  rewardPool?: bigint;
  cutoff?: bigint;
  epoch?: bigint;
  nextMilestone?: bigint;
  assignedWorker?: Hex;
  acceptedHead?: Hex;
  acceptedSequence?: bigint;
  acceptedManifestRef?: string;
  unallocated?: bigint;
  milestoneCount?: bigint;
  blockTimestamp?: bigint;
  totalCredited?: bigint;
  totalWithdrawn?: bigint;
  totalRefunded?: bigint;
  blockHash?: Hex;
  latestBlock?: bigint;
} = {}) {
  let blockReads = 0;
  return {
    async getChainId() {
      return options.chainId ?? 11155111;
    },
    async getBlockNumber() {
      return options.latestBlock ?? blockNumber;
    },
    async getBlock() {
      blockReads += 1;
      return {
        hash: blockReads > 1 ? (options.afterHash ?? options.blockHash ?? blockHash) : (options.blockHash ?? blockHash),
        timestamp: options.blockTimestamp ?? 1_800_000_000n,
      };
    },
    async readContract(input: { functionName: string; blockNumber?: bigint }) {
      options.calls?.push({ functionName: input.functionName, blockNumber: input.blockNumber });
      switch (input.functionName) {
        case "PROTOCOL_VERSION":
          return keccak256(stringToHex("BATON_JOB_ESCROW_V2"));
        case "jobs":
          return [
            options.buyer ?? buyer,
            options.rewardToken ?? token,
            adapter,
            options.verifier ?? verifier,
            options.termsHash ?? termsHash,
            options.taskId ?? chainTaskId,
            options.rewardPool ?? 10n,
            options.cutoff ?? 1_900_000_000n,
            options.epoch ?? 2n,
            options.nextMilestone ?? 1n,
            options.assignedWorker ?? worker,
            options.acceptedHead ?? acceptedHead,
            options.unallocated ?? 7n,
            false,
            false,
            false,
            options.totalCredited ?? 3n,
            options.totalWithdrawn ?? 0n,
            options.totalRefunded ?? 0n,
          ];
        case "acceptedCheckpoint":
          return [options.acceptedHead ?? acceptedHead, options.acceptedSequence ?? 1n, options.acceptedManifestRef ?? manifestRef];
        case "hasWorkerGrant":
          return options.granted ?? true;
        case "milestoneCount":
          return options.milestoneCount ?? 0n;
        default:
          throw new Error(`UNEXPECTED_CONTRACT_READ:${input.functionName}`);
      }
    },
  } as never;
}

function admission(): ChainAdmission {
  return {
    chainJobId,
    chainTaskId,
    termsHash,
    acceptedHead,
    acceptedSequence: 1,
    acceptedManifestRef: manifestRef,
    buyer,
    worker,
    epoch: 2,
  };
}

function address(character: string): Hex {
  return `0x${character.repeat(40)}`;
}

function digest(character: string): Hex {
  return `0x${character.repeat(64)}`;
}

function importSnapshot(): JobSnapshot {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = new JobStore("unused.json").prepareCreate({
    buyer,
    rewardToken: token,
    verifier,
    rewards: [3n, 4n],
    serviceBudget: 5n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 3n,
    cutoff: now + 600,
  });
  snapshot.chainJobId = chainJobId;
  snapshot.chainTaskId = chainTaskId;
  return snapshot;
}
