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
  private readonly client: AuthorityPublicClient;
  private readonly escrowAddress: Address;
  private readonly adapterAddress: Address;
  private readonly confirmationBlocks: number;
  private lastRead: ConfirmedChainRead | undefined;

  public constructor(input: {
    rpcUrl?: string;
    escrowAddress: string;
    adapterAddress: string;
    confirmationBlocks?: number;
    client?: AuthorityPublicClient;
  }) {
    if (!input.client && !input.rpcUrl) throw new Error("CHAIN_AUTHORITY_CONFIG_INCOMPLETE");
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
    this.client = input.client ?? createPublicClient({ chain: sepolia, transport: http(input.rpcUrl!) });
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
      const chainId = await this.client.getChainId();
      if (chainId !== sepolia.id) throw new Error("CHAIN_NETWORK_MISMATCH");

      const latestBlock = await this.client.getBlockNumber();
      const depth = BigInt(this.confirmationBlocks);
      if (latestBlock < depth) throw new Error("CHAIN_CONFIRMATION_UNAVAILABLE");
      const blockNumber = latestBlock - depth;
      const blockBefore = await this.client.getBlock({ blockNumber });
      if (!blockBefore.hash) throw new Error("CHAIN_BLOCK_HASH_UNAVAILABLE");

      let protocolVersion: Hex;
      try {
        protocolVersion = await this.client.readContract({
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
        this.client.readContract({
          address: this.escrowAddress,
          abi: escrowAbi,
          functionName: "jobs",
          args: [input.chainJobId],
          blockNumber,
        }),
        this.client.readContract({
          address: this.escrowAddress,
          abi: escrowAbi,
          functionName: "acceptedCheckpoint",
          args: [input.chainJobId],
          blockNumber,
        }),
        options.includeGrant === false ? Promise.resolve(false) : this.client.readContract({
          address: this.adapterAddress,
          abi: authorityAbi,
          functionName: "hasWorkerGrant",
          args: [input.chainJobId, getAddress(input.worker)],
          blockNumber,
        }),
        options.includeMilestoneCount === true ? this.client.readContract({
          address: this.escrowAddress,
          abi: escrowAbi,
          functionName: "milestoneCount",
          args: [input.chainJobId],
          blockNumber,
        }) : Promise.resolve(0n),
      ]);
      const blockAfter = await this.client.getBlock({ blockNumber });
      if (!blockAfter.hash || blockBefore.hash.toLowerCase() !== blockAfter.hash.toLowerCase()) {
        throw new Error("CHAIN_STATE_REORGED");
      }
      this.lastRead = { blockNumber, blockHash: blockAfter.hash, confirmationBlocks: this.confirmationBlocks };
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
        "ESCROW_PROTOCOL_MISMATCH",
      ].includes(error.message)) throw error;
      throw new Error("CHAIN_AUTHORITY_UNAVAILABLE");
    }
  }
}

const zeroAddress = "0x0000000000000000000000000000000000000000";
