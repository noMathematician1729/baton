import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseTransaction,
  parseAbi,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerialized,
  type TransactionSerializedGeneric,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { JobSnapshot } from "../protocol/v1.js";
import type { MilestoneOffer, TakeoverAck } from "./signing.js";

const escrowAbi = parseAbi([
  "function assignTask(bytes32 jobId, address worker)",
  "function acceptMilestone(bytes32 jobId, (bytes32 jobId, bytes32 taskId, bytes32 termsHash, address producer, uint64 epoch, uint32 milestone, bytes32 acceptanceSpecHash, bytes32 expectedHead, bytes32 newHead, string manifestRef, uint64 sequence, uint256 nonce, uint64 expiry) offer, bytes signature)",
  "function drainTask(bytes32 jobId)",
  "function takeover(bytes32 jobId, (bytes32 jobId, bytes32 taskId, bytes32 termsHash, address successor, uint64 epoch, bytes32 expectedHead, bytes32 compatibilityReport, bytes32 servicePolicy, uint256 nonce, uint64 expiry) ack, bytes signature)",
  "function pause(bytes32 jobId)",
  "function resume(bytes32 jobId)",
  "function claim(bytes32 jobId)",
]);

type ContractCall = {
  address: Address;
  abi: typeof escrowAbi;
  functionName: string;
  args: readonly unknown[];
  account: Address;
};

export interface SepoliaTransactionClient {
  getChainId(): Promise<number>;
  simulateContract(call: ContractCall): Promise<{ request: unknown }>;
  broadcastTransaction(serializedTransaction: Hex): Promise<Hex>;
  waitForTransactionReceipt(input: { hash: Hex; confirmations: number }): Promise<{ status: "success" | "reverted" }>;
}

export interface SepoliaContractWallet {
  readonly address: Address;
  writeContract(request: unknown): Promise<Hex>;
}

export interface EscrowMutationWriter {
  assign(job: JobSnapshot, worker: Hex): Promise<void>;
  acceptMilestone(job: JobSnapshot, offer: MilestoneOffer, signature: Hex): Promise<void>;
  drain(job: JobSnapshot): Promise<void>;
  takeover(job: JobSnapshot, ack: TakeoverAck, signature: Hex): Promise<void>;
  pause(job: JobSnapshot): Promise<void>;
  resume(job: JobSnapshot): Promise<void>;
  claim(job: JobSnapshot, worker: Hex, signedTransaction: Hex): Promise<void>;
}

/** Buyer-paid Sepolia writes. Every call is simulated and mined before returning. */
export class SepoliaEscrowWriter implements EscrowMutationWriter {
  private readonly escrowAddress: Address;
  private readonly buyer: SepoliaContractWallet;
  private readonly client: SepoliaTransactionClient;
  private readonly confirmations: number;

  public constructor(input: {
    rpcUrl: string;
    escrowAddress: string;
    buyerPrivateKey: string;
    confirmationBlocks?: number;
    client?: SepoliaTransactionClient;
    buyerWallet?: SepoliaContractWallet;
  }) {
    try {
      this.escrowAddress = getAddress(input.escrowAddress);
    } catch {
      throw new Error("CHAIN_MUTATION_CONFIG_INVALID");
    }
    this.confirmations = input.confirmationBlocks ?? 2;
    if (!Number.isSafeInteger(this.confirmations) || this.confirmations < 0) {
      throw new Error("CHAIN_CONFIRMATION_CONFIG_INVALID");
    }

    this.buyer = input.buyerWallet ?? walletFor(input.buyerPrivateKey, input.rpcUrl);

    if (input.client) {
      this.client = input.client;
    } else {
      const publicClient = createPublicClient({ chain: sepolia, transport: http(input.rpcUrl) });
      this.client = {
        getChainId: () => publicClient.getChainId(),
        simulateContract: async (call) => publicClient.simulateContract(call as never) as Promise<{ request: unknown }>,
        broadcastTransaction: (serializedTransaction) => publicClient.sendRawTransaction({
          serializedTransaction: serializedTransaction as TransactionSerializedGeneric,
        }),
        waitForTransactionReceipt: async ({ hash, confirmations }) => {
          const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
          return { status: receipt.status };
        },
      };
    }
  }

  public async assign(job: JobSnapshot, worker: Hex): Promise<void> {
    this.requireBuyer(job);
    await this.send(this.buyer, "assignTask", [this.jobId(job), getAddress(worker)]);
  }

  public async acceptMilestone(job: JobSnapshot, offer: MilestoneOffer, signature: Hex): Promise<void> {
    this.requireBuyer(job);
    await this.send(this.buyer, "acceptMilestone", [this.jobId(job), offer, signature]);
  }

  public async drain(job: JobSnapshot): Promise<void> {
    this.requireBuyer(job);
    await this.send(this.buyer, "drainTask", [this.jobId(job)]);
  }

  public async takeover(job: JobSnapshot, ack: TakeoverAck, signature: Hex): Promise<void> {
    this.requireBuyer(job);
    await this.send(this.buyer, "takeover", [this.jobId(job), ack, signature]);
  }

  public async pause(job: JobSnapshot): Promise<void> {
    this.requireBuyer(job);
    await this.send(this.buyer, "pause", [this.jobId(job)]);
  }

  public async resume(job: JobSnapshot): Promise<void> {
    this.requireBuyer(job);
    await this.send(this.buyer, "resume", [this.jobId(job)]);
  }

  public async claim(job: JobSnapshot, worker: Hex, signedTransaction: Hex): Promise<void> {
    if (await this.client.getChainId() !== sepolia.id) throw new Error("CHAIN_NETWORK_MISMATCH");
    let transaction;
    let recovered: Address;
    try {
      transaction = parseTransaction(signedTransaction);
      recovered = await recoverTransactionAddress({ serializedTransaction: signedTransaction as TransactionSerialized });
    } catch {
      throw new Error("WORKER_CLAIM_TRANSACTION_INVALID");
    }
    const jobId = this.jobId(job);
    const expectedData = encodeFunctionData({ abi: escrowAbi, functionName: "claim", args: [jobId] });
    if (transaction.chainId !== sepolia.id || !transaction.to
      || getAddress(transaction.to) !== this.escrowAddress
      || transaction.data?.toLowerCase() !== expectedData.toLowerCase()
      || (transaction.value ?? 0n) !== 0n
      || getAddress(recovered) !== getAddress(worker)) {
      throw new Error("WORKER_CLAIM_TRANSACTION_INVALID");
    }
    try {
      await this.client.simulateContract({
        address: this.escrowAddress,
        abi: escrowAbi,
        functionName: "claim",
        args: [jobId],
        account: getAddress(worker),
      });
    } catch {
      throw new Error("CHAIN_MUTATION_SIMULATION_FAILED");
    }
    const expectedHash = keccak256(signedTransaction);
    let hash: Hex;
    try {
      hash = await this.client.broadcastTransaction(signedTransaction);
      if (hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("hash mismatch");
    } catch {
      // A transport failure can happen after the node accepted the signed transaction.
      // Reconcile only its deterministic hash; never build or broadcast a replacement.
      hash = expectedHash;
    }
    const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: Math.max(1, this.confirmations) });
    if (receipt.status !== "success") throw new Error("CHAIN_MUTATION_REVERTED");
  }

  private async send(
    signer: SepoliaContractWallet,
    functionName: ContractCall["functionName"],
    args: ContractCall["args"],
  ): Promise<void> {
    if (await this.client.getChainId() !== sepolia.id) throw new Error("CHAIN_NETWORK_MISMATCH");
    const call: ContractCall = { address: this.escrowAddress, abi: escrowAbi, functionName, args, account: signer.address };
    let request: unknown;
    try {
      ({ request } = await this.client.simulateContract(call));
    } catch {
      throw new Error("CHAIN_MUTATION_SIMULATION_FAILED");
    }
    const hash = await signer.writeContract(request);
    const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: Math.max(1, this.confirmations) });
    if (receipt.status !== "success") throw new Error("CHAIN_MUTATION_REVERTED");
  }

  private requireBuyer(job: JobSnapshot): void {
    if (getAddress(job.terms.buyer) !== this.buyer.address) throw new Error("CHAIN_BUYER_SIGNER_MISMATCH");
  }

  private jobId(job: JobSnapshot): Hex {
    if (!job.chainJobId) throw new Error("CHAIN_JOB_ID_REQUIRED");
    return job.chainJobId;
  }
}

function walletFor(privateKey: string, rpcUrl: string): SepoliaContractWallet {
  let account;
  try {
    const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    if (!/^0x[\da-f]{64}$/i.test(normalized)) throw new Error("invalid");
    account = privateKeyToAccount(normalized as Hex);
  } catch {
    throw new Error("CHAIN_SIGNER_KEY_INVALID");
  }
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });
  return {
    address: getAddress(account.address),
    writeContract: async (request) => wallet.writeContract(request as never),
  };
}
