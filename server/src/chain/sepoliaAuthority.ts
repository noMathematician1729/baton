import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { EMPTY_HEAD, type JobSnapshot } from "../protocol/v1.js";
import { parseInitialChainJobSnapshot, rewardPoolFromSnapshot } from "./chainJobImport.js";

const escrowAbi = parseAbi([
  "function PROTOCOL_VERSION() view returns (bytes32)",
  "function jobs(bytes32 jobId) view returns (address buyer, address rewardToken, address authority, address verifier, bytes32 termsHash, bytes32 taskId, uint256 rewardPool, uint64 cutoff, uint64 epoch, uint32 nextMilestone, address assignedWorker, bytes32 acceptedHead, uint256 unallocated, bool paused, bool drained, bool closed, uint256 totalCredited, uint256 totalWithdrawn, uint256 totalRefunded)",
  "function acceptedCheckpoint(bytes32 jobId) view returns (bytes32 head, uint64 sequence, string manifestRef)",
  "function milestoneCount(bytes32 jobId) view returns (uint256)",
]);
const authorityAbi = parseAbi([
  "function hasWorkerGrant(bytes32 jobId, address worker) view returns (bool)",
]);
const expectedEscrowVersion = keccak256(stringToHex("BATON_JOB_ESCROW_V2"));
type AuthorityPublicClient = Pick<PublicClient, "getChainId" | "getBlockNumber" | "getBlock" | "readContract">;

export type ChainAdmission = {
  chainJobId: Hex;
  chainTaskId: Hex;
  termsHash: Hex;
  acceptedHead: Hex;
  acceptedSequence: number;
  acceptedManifestRef: string;
  buyer: Hex;
  worker: Hex;
  epoch: number;
};

export type ConfirmedChainRead = {
  blockNumber: bigint;
  blockHash: Hex;
  confirmationBlocks: number;
};

export interface JobAuthorityReader {
  readonly lastConfirmedRead?: ConfirmedChainRead;
  assertCurrentWorker(input: ChainAdmission): Promise<void>;
  assertAssignedWorker(input: ChainAdmission): Promise<void>;
  assertImportableJob?(input: JobSnapshot): Promise<void>;
}

type EscrowJobState = {
  buyer: Address;
  rewardToken: Address;
  authority: Address;
  verifier: Address;
  termsHash: Hex;
  taskId: Hex;
  rewardPool: bigint;
  acceptedHead: Hex;
  acceptedSequence: bigint;
  acceptedManifestRef: string;
  cutoff: bigint;
  epoch: bigint;
  nextMilestone: bigint;
  assignedWorker: Address;
  unallocated: bigint;
  paused: boolean;
  drained: boolean;
  closed: boolean;
  totalCredited: bigint;
  totalWithdrawn: bigint;
  totalRefunded: bigint;
  blockTimestamp: bigint;
};

export class SepoliaAuthorityReader implements JobAuthorityReader {
  private readonly clients: readonly AuthorityPublicClient[];
  private readonly escrowAddress: Address;
  private readonly adapterAddress: Address;
  private readonly confirmationBlocks: number;
  private readonly maxRpcHeadLagBlocks: number;
  private lastRead: ConfirmedChainRead | undefined;

  public constructor(input: {
    rpcUrl?: string;
    escrowAddress: string;
    adapterAddress: string;
    confirmationBlocks?: number;
    client?: AuthorityPublicClient;
    additionalClients?: readonly AuthorityPublicClient[];
    backupRpcUrls?: readonly string[];
    maxRpcHeadLagBlocks?: number;
  }) {
    const injectedClients = input.client ? [input.client, ...(input.additionalClients ?? [])] : [];
    const rpcUrls = [input.rpcUrl, ...(input.backupRpcUrls ?? [])].filter((url): url is string => Boolean(url?.trim()));
    if (injectedClients.length === 0 && rpcUrls.length === 0) throw new Error("CHAIN_AUTHORITY_CONFIG_INCOMPLETE");
    try {
      this.escrowAddress = getAddress(input.escrowAddress);
      this.adapterAddress = getAddress(input.adapterAddress);
    } catch {
      throw new Error("CHAIN_AUTHORITY_CONFIG_INVALID");
    }
    this.confirmationBlocks = input.confirmationBlocks ?? 0;
    if (!Number.isSafeInteger(this.confirmationBlocks) || this.confirmationBlocks < 0) {
      throw new Error("CHAIN_CONFIRMATION_CONFIG_INVALID");
    }
    this.maxRpcHeadLagBlocks = input.maxRpcHeadLagBlocks ?? 2;
    if (!Number.isSafeInteger(this.maxRpcHeadLagBlocks) || this.maxRpcHeadLagBlocks < 0) {
      throw new Error("CHAIN_RPC_LAG_CONFIG_INVALID");
    }
    this.clients = injectedClients.length > 0
      ? injectedClients
      : rpcUrls.map((rpcUrl) => createPublicClient({ chain: sepolia, transport: http(rpcUrl) }));
  }

  public get lastConfirmedRead(): ConfirmedChainRead | undefined {
    return this.lastRead ? { ...this.lastRead } : undefined;
  }

  public async assertCurrentWorker(input: ChainAdmission): Promise<void> {
    const { state, granted } = await this.readConfirmedJob(input);
    this.assertBinding(state, input);
    if (state.assignedWorker.toLowerCase() !== input.worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
    if (state.epoch !== BigInt(input.epoch)) throw new Error("STALE_EPOCH");
    if (state.paused || state.drained || state.closed || state.cutoff <= state.blockTimestamp) {
      throw new Error("GATEWAY_DRAINED");
    }
    if (!granted) throw new Error("WORKER_AUTHORITY_REVOKED");
  }

  public async assertAssignedWorker(input: ChainAdmission): Promise<void> {
    const { state, granted } = await this.readConfirmedJob(input);
    this.assertBinding(state, input);
    if (state.assignedWorker.toLowerCase() !== input.worker.toLowerCase()) throw new Error("ONCHAIN_ASSIGNMENT_NOT_CONFIRMED");
    if (state.epoch !== BigInt(input.epoch)) throw new Error("ONCHAIN_EPOCH_NOT_CONFIRMED");
    if (state.paused || state.drained || state.closed || state.cutoff <= state.blockTimestamp) {
      throw new Error("ONCHAIN_JOB_NOT_OPEN");
    }
    if (!granted) throw new Error("WORKER_AUTHORITY_REVOKED");
  }

  public async assertImportableJob(input: JobSnapshot): Promise<void> {
    const job = parseInitialChainJobSnapshot(input);
    const chainJobId = job.chainJobId!;
    const chainTaskId = job.chainTaskId!;
    const { state, milestoneCount } = await this.readConfirmedJob({
      chainJobId,
      chainTaskId,
      termsHash: job.terms.termsHash,
      acceptedHead: EMPTY_HEAD as Hex,
      acceptedSequence: 0,
      acceptedManifestRef: "",
      buyer: job.terms.buyer,
      worker: zeroAddress as Hex,
      epoch: 0,
    }, { includeGrant: false, includeMilestoneCount: true });

    this.assertBinding(state, {
      chainJobId,
      chainTaskId,
      termsHash: job.terms.termsHash,
      acceptedHead: EMPTY_HEAD as Hex,
      acceptedSequence: 0,
      acceptedManifestRef: "",
      buyer: job.terms.buyer,
      worker: zeroAddress as Hex,
      epoch: 0,
    });
    if (state.rewardToken.toLowerCase() !== job.terms.rewardToken.toLowerCase()) throw new Error("ONCHAIN_REWARD_TOKEN_MISMATCH");
    if (state.verifier.toLowerCase() !== job.terms.verifier.toLowerCase()) throw new Error("ONCHAIN_VERIFIER_MISMATCH");
    if (state.cutoff !== BigInt(job.terms.cutoff) || job.terms.task.deadline !== job.terms.cutoff) {
      throw new Error("ONCHAIN_CUTOFF_MISMATCH");
    }
    if (state.blockTimestamp >= state.cutoff) throw new Error("ONCHAIN_JOB_EXPIRED");
    if (state.rewardPool !== rewardPoolFromSnapshot(job) || state.unallocated !== state.rewardPool) {
      throw new Error("ONCHAIN_REWARD_POOL_MISMATCH");
    }
    if (BigInt(milestoneCount) !== BigInt(job.terms.task.milestones.length)) throw new Error("ONCHAIN_MILESTONE_COUNT_MISMATCH");
    if (state.epoch !== 0n || state.nextMilestone !== 0n || state.assignedWorker.toLowerCase() !== zeroAddress
      || state.acceptedHead.toLowerCase() !== EMPTY_HEAD || state.acceptedSequence !== 0n
      || state.acceptedManifestRef !== "" || state.paused || state.drained || state.closed
      || state.totalCredited !== 0n || state.totalWithdrawn !== 0n || state.totalRefunded !== 0n) {
      throw new Error("ONCHAIN_JOB_NOT_IMPORTABLE");
    }
  }

  private assertBinding(state: EscrowJobState, input: ChainAdmission): void {
    if (state.buyer === zeroAddress) throw new Error("ONCHAIN_JOB_NOT_FOUND");
    if (state.buyer.toLowerCase() !== input.buyer.toLowerCase()) throw new Error("ONCHAIN_BUYER_MISMATCH");
    if (state.authority.toLowerCase() !== this.adapterAddress.toLowerCase()) {
      throw new Error("ONCHAIN_AUTHORITY_MISMATCH");
    }
    if (state.taskId.toLowerCase() !== input.chainTaskId.toLowerCase()) throw new Error("ONCHAIN_TASK_MISMATCH");
    if (state.termsHash.toLowerCase() !== input.termsHash.toLowerCase()) throw new Error("ONCHAIN_TERMS_MISMATCH");
    if (state.acceptedHead.toLowerCase() !== input.acceptedHead.toLowerCase()) throw new Error("ONCHAIN_HEAD_MISMATCH");
    if (state.acceptedSequence !== BigInt(input.acceptedSequence)) throw new Error("ONCHAIN_SEQUENCE_MISMATCH");
    if (state.acceptedManifestRef !== input.acceptedManifestRef) throw new Error("ONCHAIN_LOCATOR_MISMATCH");
  }

  private async readConfirmedJob(
    input: ChainAdmission,
    options: { includeGrant?: boolean; includeMilestoneCount?: boolean } = {},
  ): Promise<{ state: EscrowJobState; granted: boolean; milestoneCount: bigint }> {
    try {
      const chainIds = await Promise.all(this.clients.map((client) => client.getChainId()));
      if (chainIds.some((chainId) => chainId !== sepolia.id)) throw new Error("CHAIN_NETWORK_MISMATCH");

      const latestBlocks = await Promise.all(this.clients.map((client) => client.getBlockNumber()));
      const minimumLatestBlock = latestBlocks.reduce((minimum, block) => block < minimum ? block : minimum);
      const maximumLatestBlock = latestBlocks.reduce((maximum, block) => block > maximum ? block : maximum);
      if (maximumLatestBlock - minimumLatestBlock > BigInt(this.maxRpcHeadLagBlocks)) {
        throw new Error("CHAIN_RPC_DISAGREEMENT");
      }
      const depth = BigInt(this.confirmationBlocks);
      if (minimumLatestBlock < depth) throw new Error("CHAIN_CONFIRMATION_UNAVAILABLE");
      const blockNumber = minimumLatestBlock - depth;
      const blocksBefore = await Promise.all(this.clients.map((client) => client.getBlock({ blockNumber })));
      const agreedBlockHash = blocksBefore[0]?.hash;
      if (!agreedBlockHash || blocksBefore.some((block) => !block.hash)) throw new Error("CHAIN_BLOCK_HASH_UNAVAILABLE");
      if (blocksBefore.some((block) => block.hash!.toLowerCase() !== agreedBlockHash.toLowerCase())) {
        throw new Error("CHAIN_RPC_DISAGREEMENT");
      }

      const readings = await Promise.all(this.clients.map(async (client, index) => {
        let protocolVersion: Hex;
        try {
          protocolVersion = await client.readContract({
            address: this.escrowAddress,
            abi: escrowAbi,
            functionName: "PROTOCOL_VERSION",
            blockNumber,
          });
        } catch {
          throw new Error("ESCROW_PROTOCOL_MISMATCH");
        }
        if (protocolVersion.toLowerCase() !== expectedEscrowVersion.toLowerCase()) {
          throw new Error("ESCROW_PROTOCOL_MISMATCH");
        }

        const [result, checkpoint, granted, milestoneCount] = await Promise.all([
          client.readContract({
            address: this.escrowAddress,
            abi: escrowAbi,
            functionName: "jobs",
            args: [input.chainJobId],
            blockNumber,
          }),
          client.readContract({
            address: this.escrowAddress,
            abi: escrowAbi,
            functionName: "acceptedCheckpoint",
            args: [input.chainJobId],
            blockNumber,
          }),
          options.includeGrant === false ? Promise.resolve(false) : client.readContract({
            address: this.adapterAddress,
            abi: authorityAbi,
            functionName: "hasWorkerGrant",
            args: [input.chainJobId, getAddress(input.worker)],
            blockNumber,
          }),
          options.includeMilestoneCount === true ? client.readContract({
            address: this.escrowAddress,
            abi: escrowAbi,
            functionName: "milestoneCount",
            args: [input.chainJobId],
            blockNumber,
          }) : Promise.resolve(0n),
        ]);
        const blockAfter = await client.getBlock({ blockNumber });
        if (!blockAfter.hash || blocksBefore[index]?.hash?.toLowerCase() !== blockAfter.hash.toLowerCase()) {
          throw new Error("CHAIN_STATE_REORGED");
        }
        return { result, checkpoint, granted, milestoneCount, blockAfter };
      }));
      const referenceFingerprint = confirmedReadFingerprint(readings[0]!);
      if (readings.some((reading) => confirmedReadFingerprint(reading) !== referenceFingerprint)) {
        throw new Error("CHAIN_RPC_DISAGREEMENT");
      }
      const { result, checkpoint, granted, milestoneCount, blockAfter } = readings[0]!;
      this.lastRead = { blockNumber, blockHash: blockAfter.hash!, confirmationBlocks: this.confirmationBlocks };
      return {
        state: {
          buyer: result[0],
          rewardToken: result[1],
          authority: result[2],
          verifier: result[3],
          termsHash: result[4],
          taskId: result[5],
          rewardPool: result[6],
          cutoff: result[7],
          epoch: result[8],
          nextMilestone: BigInt(result[9]),
          assignedWorker: result[10],
          unallocated: result[12],
          acceptedHead: checkpoint[0],
          acceptedSequence: checkpoint[1],
          acceptedManifestRef: checkpoint[2],
          paused: result[13],
          drained: result[14],
          closed: result[15],
          totalCredited: result[16],
          totalWithdrawn: result[17],
          totalRefunded: result[18],
          blockTimestamp: blockAfter.timestamp,
        },
        granted,
        milestoneCount: BigInt(milestoneCount),
      };
    } catch (error) {
      if (error instanceof Error && [
        "CHAIN_NETWORK_MISMATCH",
        "CHAIN_CONFIRMATION_UNAVAILABLE",
        "CHAIN_BLOCK_HASH_UNAVAILABLE",
        "CHAIN_STATE_REORGED",
        "CHAIN_RPC_DISAGREEMENT",
        "ESCROW_PROTOCOL_MISMATCH",
      ].includes(error.message)) throw error;
      throw new Error("CHAIN_AUTHORITY_UNAVAILABLE");
    }
  }
}

function confirmedReadFingerprint(reading: {
  result: readonly unknown[];
  checkpoint: readonly unknown[];
  granted: boolean;
  milestoneCount: bigint;
}): string {
  const normalize = (value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string" && /^0x[\da-f]+$/i.test(value)) return value.toLowerCase();
    return value;
  };
  return JSON.stringify([
    reading.result.map(normalize),
    reading.checkpoint.map(normalize),
    reading.granted,
    reading.milestoneCount.toString(),
  ]);
}

const zeroAddress = "0x0000000000000000000000000000000000000000";
