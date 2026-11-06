import {
  createPublicClient,
  decodeFunctionData,
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
  "function credits(bytes32 jobId, address worker) view returns (uint256)",
  "function withdrawnCredits(bytes32 jobId, address worker) view returns (uint256)",
]);
const claimAbi = parseAbi(["function claim(bytes32 jobId)"]);
const authorityAbi = parseAbi([
  "function hasWorkerGrant(bytes32 jobId, address worker) view returns (bool)",
]);
const expectedEscrowVersion = keccak256(stringToHex("BATON_JOB_ESCROW_V2"));
type AuthorityPublicClient = Pick<PublicClient, "getChainId" | "getBlockNumber" | "getBlock" | "readContract">
  & Partial<Pick<PublicClient, "getTransaction" | "getTransactionReceipt">>;

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

export type ConfirmedTakeoverState = {
  assignedWorker: Hex;
  epoch: number;
  nextMilestone: number;
  totalCredited: bigint;
  acceptedHead: Hex;
  acceptedSequence: number;
  acceptedManifestRef: string;
  paused: boolean;
  drained: boolean;
  closed: boolean;
  expired: boolean;
  successorGranted: boolean;
};

export type ConfirmedWorkerAccounting = {
  credits: bigint;
  withdrawnCredits: bigint;
};

export interface JobAuthorityReader {
  readonly lastConfirmedRead?: ConfirmedChainRead;
  assertCurrentWorker(input: ChainAdmission): Promise<void>;
  assertAssignedWorker(input: ChainAdmission): Promise<void>;
  assertReconciliationWorker?(input: ChainAdmission): Promise<void>;
  assertImportableJob?(input: JobSnapshot): Promise<void>;
  assertSnapshotCurrent?(input: JobSnapshot): Promise<void>;
  assertAssignmentTransition?(job: JobSnapshot, worker: Hex): Promise<boolean>;
  assertAssignmentConfirmed?(job: JobSnapshot, worker: Hex): Promise<void>;
  assertMilestoneTransition?(job: JobSnapshot, input: {
    worker: Hex;
    epoch: number;
    acceptanceSpecHash: Hex;
    expectedHead: Hex;
    newHead: { manifestDigest: Hex; manifestRef: string; sequence: number };
  }): Promise<boolean>;
  assertMilestoneAccepted?(job: JobSnapshot, input: {
    worker: Hex;
    epoch: number;
    newHead: { manifestDigest: Hex; manifestRef: string; sequence: number };
    nextMilestone: number;
    totalCredited: bigint;
  }): Promise<void>;
  assertPauseAllowed?(job: JobSnapshot, worker: Hex): Promise<boolean>;
  assertTaskPaused?(job: JobSnapshot, worker: Hex): Promise<void>;
  assertResumeAllowed?(job: JobSnapshot, worker: Hex): Promise<boolean>;
  assertTaskResumed?(job: JobSnapshot, worker: Hex): Promise<void>;
  confirmWorkerClaim?(job: JobSnapshot, worker: Hex, transactionHash: Hex): Promise<ConfirmedWorkerAccounting>;
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

  /** Returns true when the exact assignment is already committed, making retries safe after a lost API response. */
  public async assertAssignmentTransition(job: JobSnapshot, worker: Hex): Promise<boolean> {
    const state = await this.readTakeoverState(job, worker);
    this.assertSameHead(state, job.task.acceptedHead.manifestDigest, job.task.acceptedHead.sequence, job.task.acceptedHead.manifestRef);
    if (state.nextMilestone !== 0 || state.totalCredited !== 0n || state.paused || state.drained || state.closed || state.expired) {
      throw new Error("ONCHAIN_ASSIGNMENT_STATE_MISMATCH");
    }
    if (!state.successorGranted) throw new Error("WORKER_AUTHORITY_REVOKED");
    const currentCredits = job.credits.reduce((total, credit) => total + credit.amount, 0n);
    if (currentCredits !== 0n) throw new Error("LOCAL_ASSIGNMENT_STATE_MISMATCH");
    if (state.epoch === 0 && state.assignedWorker.toLowerCase() === zeroAddress) return false;
    if (state.epoch === 1 && state.assignedWorker.toLowerCase() === worker.toLowerCase()) return true;
    throw new Error("ONCHAIN_ASSIGNMENT_STATE_MISMATCH");
  }

  public async assertAssignmentConfirmed(job: JobSnapshot, worker: Hex): Promise<void> {
    const alreadyAssigned = await this.assertAssignmentTransition(job, worker);
    if (!alreadyAssigned) throw new Error("ONCHAIN_ASSIGNMENT_NOT_CONFIRMED");
  }

  /** Classifies the exact local pre-state or the exact committed post-state for an accepted checkpoint. */
  public async assertMilestoneTransition(job: JobSnapshot, input: {
    worker: Hex;
    epoch: number;
    acceptanceSpecHash: Hex;
    expectedHead: Hex;
    newHead: { manifestDigest: Hex; manifestRef: string; sequence: number };
  }): Promise<boolean> {
    const state = await this.readTakeoverState(job, input.worker);
    if (state.assignedWorker.toLowerCase() !== input.worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
    if (state.epoch !== input.epoch) throw new Error("STALE_EPOCH");
    if (state.paused || state.drained || state.closed || state.expired) throw new Error("ONCHAIN_JOB_NOT_OPEN");
    if (!state.successorGranted) throw new Error("WORKER_AUTHORITY_REVOKED");
    const milestone = job.terms.task.milestones[job.task.nextMilestone];
    if (!milestone || milestone.acceptanceSpecHash.toLowerCase() !== input.acceptanceSpecHash.toLowerCase()) {
      throw new Error("ACCEPTANCE_SPEC_MISMATCH");
    }
    const credited = job.credits.reduce((total, credit) => total + credit.amount, 0n);
    const committed = state.acceptedHead.toLowerCase() === input.newHead.manifestDigest.toLowerCase()
      && state.acceptedSequence === input.newHead.sequence
      && state.acceptedManifestRef === input.newHead.manifestRef
      && state.nextMilestone === job.task.nextMilestone + 1
      && state.totalCredited === credited + milestone.reward;
    if (committed) return true;

    if (state.acceptedHead.toLowerCase() !== input.expectedHead.toLowerCase()
      || state.acceptedHead.toLowerCase() !== job.task.acceptedHead.manifestDigest.toLowerCase()
      || state.acceptedSequence !== job.task.acceptedHead.sequence
      || state.acceptedManifestRef !== job.task.acceptedHead.manifestRef
      || state.nextMilestone !== job.task.nextMilestone
      || state.totalCredited !== credited) throw new Error("ONCHAIN_MILESTONE_STATE_MISMATCH");
    if (input.newHead.sequence !== state.acceptedSequence + 1) throw new Error("CHECKPOINT_SEQUENCE_INVALID");
    return false;
  }

  public async assertMilestoneAccepted(job: JobSnapshot, input: {
    worker: Hex;
    epoch: number;
    newHead: { manifestDigest: Hex; manifestRef: string; sequence: number };
    nextMilestone: number;
    totalCredited: bigint;
  }): Promise<void> {
    const state = await this.readTakeoverState(job, input.worker);
    if (state.assignedWorker.toLowerCase() !== input.worker.toLowerCase()) throw new Error("ONCHAIN_ASSIGNMENT_CHANGED");
    if (state.epoch !== input.epoch) throw new Error("ONCHAIN_EPOCH_CHANGED");
    this.assertSameHead(state, input.newHead.manifestDigest, input.newHead.sequence, input.newHead.manifestRef);
    if (state.nextMilestone !== input.nextMilestone || state.totalCredited !== input.totalCredited) {
      throw new Error("ONCHAIN_MILESTONE_ACCOUNTING_MISMATCH");
    }
    if (state.paused || state.drained || state.closed || state.expired) throw new Error("ONCHAIN_JOB_NOT_OPEN");
    if (!state.successorGranted) throw new Error("WORKER_AUTHORITY_REVOKED");
  }

  public async assertPauseAllowed(job: JobSnapshot, worker: Hex): Promise<boolean> {
    const state = await this.readTakeoverState(job, worker);
    this.assertLocalLifecycle(job, state, worker);
    if (state.drained || state.closed || state.expired) throw new Error("ONCHAIN_JOB_NOT_OPEN");
    return state.paused;
  }

  public async assertTaskPaused(job: JobSnapshot, worker: Hex): Promise<void> {
    const state = await this.readTakeoverState(job, worker);
    this.assertLocalLifecycle(job, state, worker);
    if (!state.paused || state.drained || state.closed || state.expired) throw new Error("ONCHAIN_PAUSE_NOT_CONFIRMED");
  }

  public async assertResumeAllowed(job: JobSnapshot, worker: Hex): Promise<boolean> {
    const state = await this.readTakeoverState(job, worker);
    this.assertLocalLifecycle(job, state, worker);
    if (state.drained || state.closed || state.expired) throw new Error("ONCHAIN_JOB_NOT_OPEN");
    if (!state.successorGranted) throw new Error("WORKER_AUTHORITY_REVOKED");
    return state.paused;
  }

  public async assertTaskResumed(job: JobSnapshot, worker: Hex): Promise<void> {
    const state = await this.readTakeoverState(job, worker);
    this.assertLocalLifecycle(job, state, worker);
    if (state.paused || state.drained || state.closed || state.expired) throw new Error("ONCHAIN_RESUME_NOT_CONFIRMED");
    if (!state.successorGranted) throw new Error("WORKER_AUTHORITY_REVOKED");
  }

  public async confirmWorkerClaim(job: JobSnapshot, worker: Hex, transactionHash: Hex): Promise<ConfirmedWorkerAccounting> {
    if (!job.chainJobId || !job.chainTaskId) throw new Error("CHAIN_JOB_BINDING_REQUIRED");
    const chainJobId = job.chainJobId;
    const state = await this.readConfirmedJob({
      chainJobId: job.chainJobId,
      chainTaskId: job.chainTaskId,
      termsHash: job.terms.termsHash,
      acceptedHead: job.task.acceptedHead.manifestDigest,
      acceptedSequence: job.task.acceptedHead.sequence,
      acceptedManifestRef: job.task.acceptedHead.manifestRef,
      buyer: job.terms.buyer,
      worker,
      epoch: job.task.epoch,
    }, { includeGrant: false, accountingWorker: getAddress(worker) });
    this.assertJobIdentity(state.state, {
      chainJobId: job.chainJobId,
      chainTaskId: job.chainTaskId,
      termsHash: job.terms.termsHash,
      acceptedHead: job.task.acceptedHead.manifestDigest,
      acceptedSequence: job.task.acceptedHead.sequence,
      acceptedManifestRef: job.task.acceptedHead.manifestRef,
      buyer: job.terms.buyer,
      worker,
      epoch: job.task.epoch,
    });
    const confirmedBlock = this.lastRead?.blockNumber;
    if (confirmedBlock === undefined || !state.workerAccounting) throw new Error("CLAIM_CONFIRMATION_UNAVAILABLE");

    const evidence = await Promise.all(this.clients.map(async (client) => {
      if (!client.getTransaction || !client.getTransactionReceipt) throw new Error("CLAIM_CONFIRMATION_UNAVAILABLE");
      const [transaction, receipt] = await Promise.all([
        client.getTransaction({ hash: transactionHash }),
        client.getTransactionReceipt({ hash: transactionHash }),
      ]);
      if (transaction.from.toLowerCase() !== worker.toLowerCase()
        || transaction.to?.toLowerCase() !== this.escrowAddress.toLowerCase()
        || receipt.status !== "success"
        || receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
        || receipt.blockNumber > confirmedBlock) throw new Error("CLAIM_TRANSACTION_INVALID");
      let decoded;
      try {
        decoded = decodeFunctionData({ abi: claimAbi, data: transaction.input });
      } catch {
        throw new Error("CLAIM_TRANSACTION_INVALID");
      }
      if (decoded.functionName !== "claim" || decoded.args[0].toLowerCase() !== chainJobId.toLowerCase()) {
        throw new Error("CLAIM_TRANSACTION_INVALID");
      }
      const receiptBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (!receipt.blockHash || receiptBlock.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
        throw new Error("CHAIN_STATE_REORGED");
      }
      return {
        from: transaction.from.toLowerCase(),
        to: transaction.to?.toLowerCase(),
        input: transaction.input.toLowerCase(),
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash.toLowerCase(),
        status: receipt.status,
      };
    }));
    if (evidence.some((item) => JSON.stringify(item) !== JSON.stringify(evidence[0]))) {
      throw new Error("CHAIN_RPC_DISAGREEMENT");
    }
    return state.workerAccounting;
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

  /** Read the current, confirmed takeover-relevant state without assuming the local snapshot is current. */
  public async readTakeoverState(job: JobSnapshot, successor: Hex): Promise<ConfirmedTakeoverState> {
    if (!job.chainJobId || !job.chainTaskId) throw new Error("CHAIN_JOB_BINDING_REQUIRED");
    const admission: ChainAdmission = {
      chainJobId: job.chainJobId,
      chainTaskId: job.chainTaskId,
      termsHash: job.terms.termsHash,
      acceptedHead: job.task.acceptedHead.manifestDigest,
      acceptedSequence: job.task.acceptedHead.sequence,
      acceptedManifestRef: job.task.acceptedHead.manifestRef,
      buyer: job.terms.buyer,
      worker: successor,
      epoch: job.task.epoch,
    };
    const { state, granted } = await this.readConfirmedJob(admission);
    this.assertJobIdentity(state, admission);
    if (state.epoch > BigInt(Number.MAX_SAFE_INTEGER)
      || state.nextMilestone > BigInt(Number.MAX_SAFE_INTEGER)
      || state.acceptedSequence > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("ONCHAIN_STATE_OUT_OF_RANGE");
    }
    return {
      assignedWorker: state.assignedWorker,
      epoch: Number(state.epoch),
      nextMilestone: Number(state.nextMilestone),
      totalCredited: state.totalCredited,
      acceptedHead: state.acceptedHead,
      acceptedSequence: Number(state.acceptedSequence),
      acceptedManifestRef: state.acceptedManifestRef,
      paused: state.paused,
      drained: state.drained,
      closed: state.closed,
      expired: state.cutoff <= state.blockTimestamp,
      successorGranted: granted,
    };
  }

  public async assertTaskDrained(job: JobSnapshot, successor: Hex): Promise<void> {
    const state = await this.readTakeoverState(job, successor);
    this.assertSameHead(state, job.task.acceptedHead.manifestDigest, job.task.acceptedHead.sequence, job.task.acceptedHead.manifestRef);
    if (state.assignedWorker.toLowerCase() !== job.task.assignedWorker?.toLowerCase()) throw new Error("ONCHAIN_ASSIGNMENT_CHANGED");
    if (state.epoch !== job.task.epoch) throw new Error("ONCHAIN_EPOCH_CHANGED");
    if (!state.drained || state.paused || state.closed || state.expired) throw new Error("ONCHAIN_TASK_NOT_DRAINED");
  }

  /** Validate whether the buyer can safely cancel a drain; returns the confirmed chain drain flag. */
  public async assertCanCancelDrain(job: JobSnapshot, worker: Hex): Promise<boolean> {
    const state = await this.readTakeoverState(job, worker);
    this.assertSameHead(state, job.task.acceptedHead.manifestDigest, job.task.acceptedHead.sequence, job.task.acceptedHead.manifestRef);
    if (state.assignedWorker.toLowerCase() !== worker.toLowerCase()) throw new Error("ONCHAIN_ASSIGNMENT_CHANGED");
    if (state.epoch !== job.task.epoch) throw new Error("ONCHAIN_EPOCH_CHANGED");
    if (state.paused || state.closed || state.expired) throw new Error("ONCHAIN_JOB_NOT_OPEN");
    if (!state.successorGranted) throw new Error("WORKER_AUTHORITY_REVOKED");
    return state.drained;
  }

  public async assertDrainCancelled(job: JobSnapshot, worker: Hex): Promise<void> {
    const state = await this.readTakeoverState(job, worker);
    this.assertSameHead(state, job.task.acceptedHead.manifestDigest, job.task.acceptedHead.sequence, job.task.acceptedHead.manifestRef);
    if (state.assignedWorker.toLowerCase() !== worker.toLowerCase()) throw new Error("ONCHAIN_ASSIGNMENT_CHANGED");
    if (state.epoch !== job.task.epoch) throw new Error("ONCHAIN_EPOCH_CHANGED");
    if (state.drained || state.paused || state.closed || state.expired) throw new Error("ONCHAIN_JOB_NOT_OPEN");
    if (!state.successorGranted) throw new Error("WORKER_AUTHORITY_REVOKED");
  }

  public async assertPreapprovedSuccessor(job: JobSnapshot, successor: Hex): Promise<void> {
    const state = await this.readTakeoverState(job, successor);
    this.assertSameHead(state, job.task.acceptedHead.manifestDigest, job.task.acceptedHead.sequence, job.task.acceptedHead.manifestRef);
    if (state.assignedWorker.toLowerCase() !== job.task.assignedWorker?.toLowerCase()) throw new Error("ONCHAIN_ASSIGNMENT_CHANGED");
    if (state.epoch !== job.task.epoch) throw new Error("ONCHAIN_EPOCH_CHANGED");
    if (!state.drained || state.paused || state.closed || state.expired) throw new Error("ONCHAIN_TASK_NOT_DRAINED");
    if (!state.successorGranted) throw new Error("SUCCESSOR_AUTHORITY_NOT_GRANTED");
  }

  public async assertTakeoverConfirmed(
    job: JobSnapshot,
    successor: Hex,
    expectedEpoch: number,
    expectedHead: Hex,
  ): Promise<void> {
    const state = await this.readTakeoverState(job, successor);
    this.assertSameHead(state, expectedHead, job.task.acceptedHead.sequence, job.task.acceptedHead.manifestRef);
    if (state.assignedWorker.toLowerCase() !== successor.toLowerCase()) throw new Error("ONCHAIN_ASSIGNMENT_NOT_CONFIRMED");
    if (state.epoch !== expectedEpoch + 1) throw new Error("ONCHAIN_EPOCH_NOT_CONFIRMED");
    if (state.drained || state.paused || state.closed || state.expired) throw new Error("ONCHAIN_JOB_NOT_OPEN");
    if (!state.successorGranted) throw new Error("SUCCESSOR_AUTHORITY_NOT_GRANTED");
  }

  /** Confirm the original actor for already-admitted work, even while the task is drained. */
  public async assertReconciliationWorker(input: ChainAdmission): Promise<void> {
    const { state, granted } = await this.readConfirmedJob(input);
    this.assertBinding(state, input);
    if (state.assignedWorker.toLowerCase() !== input.worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
    if (state.epoch !== BigInt(input.epoch)) throw new Error("STALE_EPOCH");
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

  public async assertSnapshotCurrent(job: JobSnapshot): Promise<void> {
    if (!job.chainJobId || !job.chainTaskId) throw new Error("CHAIN_JOB_BINDING_REQUIRED");
    const admission: ChainAdmission = {
      chainJobId: job.chainJobId,
      chainTaskId: job.chainTaskId,
      termsHash: job.terms.termsHash,
      acceptedHead: job.task.acceptedHead.manifestDigest,
      acceptedSequence: job.task.acceptedHead.sequence,
      acceptedManifestRef: job.task.acceptedHead.manifestRef,
      buyer: job.terms.buyer,
      worker: zeroAddress as Hex,
      epoch: job.task.epoch,
    };
    const { state } = await this.readConfirmedJob(admission, { includeGrant: false });
    this.assertBinding(state, admission);
    if (state.rewardToken.toLowerCase() !== job.terms.rewardToken.toLowerCase()
      || state.verifier.toLowerCase() !== job.terms.verifier.toLowerCase()
      || state.cutoff !== BigInt(job.terms.cutoff)
      || state.rewardPool !== rewardPoolFromSnapshot(job)) {
      throw new Error("ONCHAIN_JOB_TERMS_MISMATCH");
    }
    const expectedWorker = (job.task.assignedWorker ?? zeroAddress).toLowerCase();
    if (state.epoch !== BigInt(job.task.epoch)
      || state.nextMilestone !== BigInt(job.task.nextMilestone)
      || state.assignedWorker.toLowerCase() !== expectedWorker
      || state.paused !== (job.task.status === "PAUSED")
      || state.drained !== job.task.drained
      || state.closed !== (job.task.status === "CLOSED")) {
      throw new Error("ONCHAIN_JOB_LIFECYCLE_MISMATCH");
    }
    const totalCredited = job.credits.reduce((total, credit) => total + credit.amount, 0n);
    const totalWithdrawn = job.credits.reduce((total, credit) => total + (credit.claimed ? credit.amount : 0n), 0n);
    if (totalCredited > state.rewardPool) throw new Error("ONCHAIN_JOB_ACCOUNTING_MISMATCH");
    const totalRefunded = state.closed ? state.rewardPool - totalCredited : 0n;
    const unallocated = state.rewardPool - totalCredited - totalRefunded;
    if (state.totalCredited !== totalCredited
      || state.totalWithdrawn !== totalWithdrawn
      || state.totalRefunded !== totalRefunded
      || state.unallocated !== unallocated) {
      throw new Error("ONCHAIN_JOB_ACCOUNTING_MISMATCH");
    }
  }

  private assertBinding(state: EscrowJobState, input: ChainAdmission): void {
    this.assertJobIdentity(state, input);
    if (state.acceptedHead.toLowerCase() !== input.acceptedHead.toLowerCase()) throw new Error("ONCHAIN_HEAD_MISMATCH");
    if (state.acceptedSequence !== BigInt(input.acceptedSequence)) throw new Error("ONCHAIN_SEQUENCE_MISMATCH");
    if (state.acceptedManifestRef !== input.acceptedManifestRef) throw new Error("ONCHAIN_LOCATOR_MISMATCH");
  }

  private assertJobIdentity(state: EscrowJobState, input: ChainAdmission): void {
    if (state.buyer === zeroAddress) throw new Error("ONCHAIN_JOB_NOT_FOUND");
    if (state.buyer.toLowerCase() !== input.buyer.toLowerCase()) throw new Error("ONCHAIN_BUYER_MISMATCH");
    if (state.authority.toLowerCase() !== this.adapterAddress.toLowerCase()) {
      throw new Error("ONCHAIN_AUTHORITY_MISMATCH");
    }
    if (state.taskId.toLowerCase() !== input.chainTaskId.toLowerCase()) throw new Error("ONCHAIN_TASK_MISMATCH");
    if (state.termsHash.toLowerCase() !== input.termsHash.toLowerCase()) throw new Error("ONCHAIN_TERMS_MISMATCH");
  }

  private assertSameHead(state: ConfirmedTakeoverState, expectedHead: Hex, sequence: number, manifestRef: string): void {
    if (state.acceptedHead.toLowerCase() !== expectedHead.toLowerCase()) throw new Error("ONCHAIN_HEAD_MISMATCH");
    if (state.acceptedSequence !== sequence) throw new Error("ONCHAIN_SEQUENCE_MISMATCH");
    if (state.acceptedManifestRef !== manifestRef) throw new Error("ONCHAIN_LOCATOR_MISMATCH");
  }

  private assertLocalLifecycle(job: JobSnapshot, state: ConfirmedTakeoverState, worker: Hex): void {
    if (state.assignedWorker.toLowerCase() !== worker.toLowerCase()) throw new Error("ONCHAIN_ASSIGNMENT_CHANGED");
    if (state.epoch !== job.task.epoch) throw new Error("ONCHAIN_EPOCH_CHANGED");
    this.assertSameHead(state, job.task.acceptedHead.manifestDigest, job.task.acceptedHead.sequence, job.task.acceptedHead.manifestRef);
    const credited = job.credits.reduce((total, credit) => total + credit.amount, 0n);
    if (state.nextMilestone !== job.task.nextMilestone || state.totalCredited !== credited) {
      throw new Error("ONCHAIN_JOB_ACCOUNTING_MISMATCH");
    }
  }

  private async readConfirmedJob(
    input: ChainAdmission,
    options: { includeGrant?: boolean; includeMilestoneCount?: boolean; accountingWorker?: Address } = {},
  ): Promise<{
    state: EscrowJobState;
    granted: boolean;
    milestoneCount: bigint;
    workerAccounting?: ConfirmedWorkerAccounting;
  }> {
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

        const [result, checkpoint, granted, milestoneCount, workerCredits, workerWithdrawnCredits] = await Promise.all([
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
          options.accountingWorker ? client.readContract({
            address: this.escrowAddress,
            abi: escrowAbi,
            functionName: "credits",
            args: [input.chainJobId, options.accountingWorker],
            blockNumber,
          }) : Promise.resolve(0n),
          options.accountingWorker ? client.readContract({
            address: this.escrowAddress,
            abi: escrowAbi,
            functionName: "withdrawnCredits",
            args: [input.chainJobId, options.accountingWorker],
            blockNumber,
          }) : Promise.resolve(0n),
        ]);
        const blockAfter = await client.getBlock({ blockNumber });
        if (!blockAfter.hash || blocksBefore[index]?.hash?.toLowerCase() !== blockAfter.hash.toLowerCase()) {
          throw new Error("CHAIN_STATE_REORGED");
        }
        return { result, checkpoint, granted, milestoneCount, workerCredits, workerWithdrawnCredits, blockAfter };
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
        workerAccounting: options.accountingWorker
          ? { credits: BigInt(readings[0]!.workerCredits), withdrawnCredits: BigInt(readings[0]!.workerWithdrawnCredits) }
          : undefined,
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
  workerCredits: bigint;
  workerWithdrawnCredits: bigint;
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
    reading.workerCredits.toString(),
    reading.workerWithdrawnCredits.toString(),
  ]);
}

const zeroAddress = "0x0000000000000000000000000000000000000000";
