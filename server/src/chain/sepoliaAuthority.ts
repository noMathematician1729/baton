import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";

const escrowAbi = parseAbi([
  "function jobs(bytes32 jobId) view returns (address buyer, address rewardToken, address authority, address verifier, bytes32 termsHash, bytes32 taskId, uint256 rewardPool, uint64 cutoff, uint64 epoch, uint32 nextMilestone, address assignedWorker, bytes32 acceptedHead, uint256 unallocated, bool paused, bool drained, bool closed)",
]);
const authorityAbi = parseAbi([
  "function hasWorkerGrant(bytes32 jobId, address worker) view returns (bool)",
]);

export type ChainAdmission = {
  chainJobId: Hex;
  buyer: Hex;
  worker: Hex;
  epoch: number;
};

export interface JobAuthorityReader {
  assertCurrentWorker(input: ChainAdmission): Promise<void>;
  assertAssignedWorker(input: ChainAdmission): Promise<void>;
}

type EscrowJobState = {
  buyer: Address;
  authority: Address;
  cutoff: bigint;
  epoch: bigint;
  assignedWorker: Address;
  paused: boolean;
  drained: boolean;
  closed: boolean;
};

export class SepoliaAuthorityReader implements JobAuthorityReader {
  private readonly client;
  private readonly escrowAddress: Address;
  private readonly adapterAddress: Address;

  public constructor(input: { rpcUrl: string; escrowAddress: string; adapterAddress: string }) {
    if (!input.rpcUrl) throw new Error("CHAIN_AUTHORITY_CONFIG_INCOMPLETE");
    try {
      this.escrowAddress = getAddress(input.escrowAddress);
      this.adapterAddress = getAddress(input.adapterAddress);
    } catch {
      throw new Error("CHAIN_AUTHORITY_CONFIG_INVALID");
    }
    this.client = createPublicClient({ chain: sepolia, transport: http(input.rpcUrl) });
  }

  public async assertCurrentWorker(input: ChainAdmission): Promise<void> {
    const state = await this.readJob(input.chainJobId);
    this.assertBinding(state, input);
    if (state.assignedWorker.toLowerCase() !== input.worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
    if (state.epoch !== BigInt(input.epoch)) throw new Error("STALE_EPOCH");
    if (state.paused || state.drained || state.closed || state.cutoff <= BigInt(Math.floor(Date.now() / 1000))) {
      throw new Error("GATEWAY_DRAINED");
    }
    await this.assertGrant(input.chainJobId, input.worker);
  }

  public async assertAssignedWorker(input: ChainAdmission): Promise<void> {
    const state = await this.readJob(input.chainJobId);
    this.assertBinding(state, input);
    if (state.assignedWorker.toLowerCase() !== input.worker.toLowerCase()) throw new Error("ONCHAIN_ASSIGNMENT_NOT_CONFIRMED");
    if (state.epoch !== BigInt(input.epoch)) throw new Error("ONCHAIN_EPOCH_NOT_CONFIRMED");
    if (state.paused || state.drained || state.closed || state.cutoff <= BigInt(Math.floor(Date.now() / 1000))) {
      throw new Error("ONCHAIN_JOB_NOT_OPEN");
    }
    await this.assertGrant(input.chainJobId, input.worker);
  }

  private assertBinding(state: EscrowJobState, input: ChainAdmission): void {
    if (state.buyer === zeroAddress) throw new Error("ONCHAIN_JOB_NOT_FOUND");
    if (state.buyer.toLowerCase() !== input.buyer.toLowerCase()) throw new Error("ONCHAIN_BUYER_MISMATCH");
    if (state.authority.toLowerCase() !== this.adapterAddress.toLowerCase()) {
      throw new Error("ONCHAIN_AUTHORITY_MISMATCH");
    }
  }

  private async readJob(chainJobId: Hex): Promise<EscrowJobState> {
    try {
      const chainId = await this.client.getChainId();
      if (chainId !== sepolia.id) throw new Error("CHAIN_NETWORK_MISMATCH");
      const result = await this.client.readContract({
        address: this.escrowAddress,
        abi: escrowAbi,
        functionName: "jobs",
        args: [chainJobId],
      });
      return {
        buyer: result[0],
        authority: result[2],
        cutoff: result[7],
        epoch: result[8],
        assignedWorker: result[10],
        paused: result[13],
        drained: result[14],
        closed: result[15],
      };
    } catch (error) {
      if (error instanceof Error && error.message === "CHAIN_NETWORK_MISMATCH") throw error;
      throw new Error("CHAIN_AUTHORITY_UNAVAILABLE");
    }
  }

  private async assertGrant(chainJobId: Hex, worker: Hex): Promise<void> {
    try {
      const granted = await this.client.readContract({
        address: this.adapterAddress,
        abi: authorityAbi,
        functionName: "hasWorkerGrant",
        args: [chainJobId, getAddress(worker)],
      });
      if (!granted) throw new Error("WORKER_AUTHORITY_REVOKED");
    } catch (error) {
      if (error instanceof Error && error.message === "WORKER_AUTHORITY_REVOKED") throw error;
      throw new Error("CHAIN_AUTHORITY_UNAVAILABLE");
    }
  }
}

const zeroAddress = "0x0000000000000000000000000000000000000000";
