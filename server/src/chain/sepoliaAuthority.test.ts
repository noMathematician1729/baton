import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, stringToHex, type Hex } from "viem";
import { SepoliaAuthorityReader, type ChainAdmission } from "./sepoliaAuthority.js";

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

function fakeClient(options: {
  calls?: Array<{ functionName: string; blockNumber?: bigint }>;
  afterHash?: Hex;
  taskId?: Hex;
  granted?: boolean;
  chainId?: number;
} = {}) {
  let blockReads = 0;
  return {
    async getChainId() {
      return options.chainId ?? 11155111;
    },
    async getBlockNumber() {
      return blockNumber;
    },
    async getBlock() {
      blockReads += 1;
      return {
        hash: blockReads > 1 ? (options.afterHash ?? blockHash) : blockHash,
        timestamp: 1_800_000_000n,
      };
    },
    async readContract(input: { functionName: string; blockNumber?: bigint }) {
      options.calls?.push({ functionName: input.functionName, blockNumber: input.blockNumber });
      switch (input.functionName) {
        case "PROTOCOL_VERSION":
          return keccak256(stringToHex("BATON_JOB_ESCROW_V2"));
        case "jobs":
          return [
            buyer,
            token,
            adapter,
            verifier,
            termsHash,
            options.taskId ?? chainTaskId,
            10n,
            1_900_000_000n,
            2n,
            1,
            worker,
            acceptedHead,
            7n,
            false,
            false,
            false,
            3n,
            0n,
            0n,
          ];
        case "acceptedCheckpoint":
          return [acceptedHead, 1n, manifestRef];
        case "hasWorkerGrant":
          return options.granted ?? true;
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
