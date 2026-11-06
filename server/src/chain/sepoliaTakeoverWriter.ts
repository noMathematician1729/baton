import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { JobSnapshot } from "../protocol/v1.js";
import { domain, OFFER_TYPES, type MilestoneOffer, type TakeoverAck } from "./signing.js";

const takeoverAbi = [
  {
    type: "function",
    name: "assignTask",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "bytes32" },
      { name: "worker", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "acceptMilestone",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "bytes32" },
      {
        name: "offer",
        type: "tuple",
        components: [
          { name: "jobId", type: "bytes32" },
          { name: "taskId", type: "bytes32" },
          { name: "termsHash", type: "bytes32" },
          { name: "producer", type: "address" },
          { name: "epoch", type: "uint64" },
          { name: "milestone", type: "uint32" },
          { name: "acceptanceSpecHash", type: "bytes32" },
          { name: "expectedHead", type: "bytes32" },
          { name: "newHead", type: "bytes32" },
          { name: "manifestRef", type: "string" },
          { name: "sequence", type: "uint64" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint64" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pause",
    stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "resume",
    stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "drainTask",
    stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelDrain",
    stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "takeover",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "bytes32" },
      {
        name: "ack",
        type: "tuple",
        components: [
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
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export class SepoliaTakeoverWriter {
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;
  private readonly escrowAddress: Address;
  private readonly confirmations: number;

  public constructor(input: { rpcUrl: string; escrowAddress: string; buyerPrivateKey: string; confirmationBlocks?: number }) {
    const privateKey = normalizePrivateKey(input.buyerPrivateKey);
    this.account = privateKeyToAccount(privateKey);
    try {
      this.escrowAddress = getAddress(input.escrowAddress);
    } catch {
      throw new Error("CHAIN_AUTHORITY_CONFIG_INVALID");
    }
    this.confirmations = Math.max(1, (input.confirmationBlocks ?? 0) + 1);
    this.publicClient = createPublicClient({ chain: sepolia, transport: http(input.rpcUrl) });
    this.walletClient = createWalletClient({ account: this.account, chain: sepolia, transport: http(input.rpcUrl) });
  }

  public async drainTask(job: JobSnapshot): Promise<Hex> {
    this.assertBuyer(job);
    if (!job.chainJobId) throw new Error("CHAIN_JOB_ID_REQUIRED");
    return this.submit(await this.walletClient.writeContract({
      address: this.escrowAddress,
      abi: takeoverAbi,
      functionName: "drainTask",
      args: [job.chainJobId],
    }));
  }

  public async assignTask(job: JobSnapshot, worker: Address): Promise<Hex> {
    this.assertBuyer(job);
    if (!job.chainJobId) throw new Error("CHAIN_JOB_ID_REQUIRED");
    return this.submit(await this.walletClient.writeContract({
      address: this.escrowAddress,
      abi: takeoverAbi,
      functionName: "assignTask",
      args: [job.chainJobId, worker],
    }));
  }

  public async acceptMilestone(job: JobSnapshot, offer: MilestoneOffer, signature: Hex): Promise<Hex> {
    this.assertBuyer(job);
    if (!job.chainJobId || offer.jobId.toLowerCase() !== job.chainJobId.toLowerCase()) throw new Error("MILESTONE_JOB_MISMATCH");
    if (!job.chainTaskId || offer.taskId.toLowerCase() !== job.chainTaskId.toLowerCase()) throw new Error("MILESTONE_TASK_MISMATCH");
    if (offer.termsHash.toLowerCase() !== job.terms.termsHash.toLowerCase()) throw new Error("MILESTONE_TERMS_MISMATCH");
    if (offer.producer.toLowerCase() !== job.task.assignedWorker?.toLowerCase()) throw new Error("MILESTONE_WORKER_MISMATCH");
    if (offer.epoch !== BigInt(job.task.epoch)) throw new Error("STALE_EPOCH");
    if (offer.milestone !== job.task.nextMilestone) throw new Error("STALE_MILESTONE");
    if (offer.expectedHead.toLowerCase() !== job.task.acceptedHead.manifestDigest.toLowerCase()) throw new Error("STALE_HEAD");
    if (offer.sequence !== BigInt(job.task.acceptedHead.sequence + 1)) throw new Error("CHECKPOINT_SEQUENCE_INVALID");
    const milestone = job.terms.task.milestones[offer.milestone];
    if (!milestone || milestone.acceptanceSpecHash.toLowerCase() !== offer.acceptanceSpecHash.toLowerCase()) {
      throw new Error("ACCEPTANCE_SPEC_MISMATCH");
    }
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        domain: domain(sepolia.id, this.escrowAddress),
        types: OFFER_TYPES,
        primaryType: "MilestoneOffer",
        message: offer,
        signature,
      });
    } catch {
      throw new Error("MILESTONE_OFFER_SIGNATURE_INVALID");
    }
    if (signer.toLowerCase() !== offer.producer.toLowerCase()) throw new Error("MILESTONE_OFFER_SIGNATURE_INVALID");
    return this.submit(await this.walletClient.writeContract({
      address: this.escrowAddress,
      abi: takeoverAbi,
      functionName: "acceptMilestone",
      args: [job.chainJobId, offer, signature],
    }));
  }

  public async pause(job: JobSnapshot): Promise<Hex> {
    this.assertBuyer(job);
    if (!job.chainJobId) throw new Error("CHAIN_JOB_ID_REQUIRED");
    return this.submit(await this.walletClient.writeContract({
      address: this.escrowAddress,
      abi: takeoverAbi,
      functionName: "pause",
      args: [job.chainJobId],
    }));
  }

  public async resume(job: JobSnapshot): Promise<Hex> {
    this.assertBuyer(job);
    if (!job.chainJobId) throw new Error("CHAIN_JOB_ID_REQUIRED");
    return this.submit(await this.walletClient.writeContract({
      address: this.escrowAddress,
      abi: takeoverAbi,
      functionName: "resume",
      args: [job.chainJobId],
    }));
  }

  public async cancelDrain(job: JobSnapshot): Promise<Hex> {
    this.assertBuyer(job);
    if (!job.chainJobId) throw new Error("CHAIN_JOB_ID_REQUIRED");
    return this.submit(await this.walletClient.writeContract({
      address: this.escrowAddress,
      abi: takeoverAbi,
      functionName: "cancelDrain",
      args: [job.chainJobId],
    }));
  }

  public async takeover(job: JobSnapshot, ack: TakeoverAck, signature: Hex): Promise<Hex> {
    this.assertBuyer(job);
    if (!job.chainJobId || ack.jobId.toLowerCase() !== job.chainJobId.toLowerCase()) throw new Error("TAKEOVER_JOB_MISMATCH");
    if (!job.chainTaskId || ack.taskId.toLowerCase() !== job.chainTaskId.toLowerCase()) throw new Error("TAKEOVER_TASK_MISMATCH");
    if (ack.termsHash.toLowerCase() !== job.terms.termsHash.toLowerCase()) throw new Error("TAKEOVER_TERMS_MISMATCH");
    if (ack.expectedHead.toLowerCase() !== job.task.acceptedHead.manifestDigest.toLowerCase()) throw new Error("STALE_HEAD");
    if (ack.epoch !== BigInt(job.task.epoch)) throw new Error("STALE_EPOCH");
    return this.submit(await this.walletClient.writeContract({
      address: this.escrowAddress,
      abi: takeoverAbi,
      functionName: "takeover",
      args: [job.chainJobId, ack, signature],
    }));
  }

  private assertBuyer(job: JobSnapshot): void {
    if (this.account.address.toLowerCase() !== getAddress(job.terms.buyer).toLowerCase()) {
      throw new Error("BUYER_TAKEOVER_SIGNER_MISMATCH");
    }
  }

  private async submit(hash: Hex): Promise<Hex> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: this.confirmations });
    if (receipt.status !== "success") throw new Error("ESCROW_TRANSACTION_REVERTED");
    return hash;
  }
}

function normalizePrivateKey(value: string): Hex {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[\da-f]{64}$/i.test(normalized)) throw new Error("BUYER_TAKEOVER_SIGNER_INVALID");
  return normalized as Hex;
}
