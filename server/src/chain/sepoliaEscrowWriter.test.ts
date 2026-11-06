import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { JobSnapshot } from "../protocol/v1.js";
import { SepoliaEscrowWriter, type ContractCall, type SepoliaContractWallet, type SepoliaTransactionClient } from "./sepoliaEscrowWriter.js";

const buyerAddress = "0x1111111111111111111111111111111111111111" as Address;
const workerAddress = "0x2222222222222222222222222222222222222222" as Address;
const job = {
  chainJobId: `0x${"a".repeat(64)}`,
  terms: { buyer: buyerAddress },
} as unknown as JobSnapshot;
const txHash = `0x${"b".repeat(64)}` as Hex;

test("escrow writes simulate, target Sepolia, and wait for configured confirmations", async () => {
  const calls: ContractCall[] = [];
  const writes: unknown[] = [];
  const waits: Array<{ hash: Hex; confirmations: number }> = [];
  const client = transactionClient({
    simulate: async (call) => { calls.push(call); return { request: call }; },
    wait: async (input) => { waits.push(input); return { status: "success" }; },
  });
  const buyer = wallet(buyerAddress, writes);
  const writer = new SepoliaEscrowWriter({
    rpcUrl: "https://rpc.invalid",
    escrowAddress: "0x3333333333333333333333333333333333333333",
    buyerPrivateKey: "not-read-with-injected-wallet",
    confirmationBlocks: 2,
    client,
    buyerWallet: buyer,
  });

  await writer.assign(job, workerAddress);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.functionName, "assignTask");
  assert.deepEqual(calls[0]?.args, [job.chainJobId, workerAddress]);
  assert.equal(calls[0]?.account, buyerAddress);
  assert.equal(writes.length, 1);
  assert.deepEqual(waits, [{ hash: txHash, confirmations: 2 }]);
});

test("network mismatch and failed simulation never submit a transaction", async () => {
  let writes = 0;
  const signer = wallet(buyerAddress, []);
  const wrongNetwork = new SepoliaEscrowWriter({
    rpcUrl: "https://rpc.invalid",
    escrowAddress: "0x3333333333333333333333333333333333333333",
    buyerPrivateKey: "unused",
    client: transactionClient({ chainId: 1 }),
    buyerWallet: signer,
  });
  await assert.rejects(wrongNetwork.assign(job, workerAddress), /CHAIN_NETWORK_MISMATCH/);

  const failedSimulation = new SepoliaEscrowWriter({
    rpcUrl: "https://rpc.invalid",
    escrowAddress: "0x3333333333333333333333333333333333333333",
    buyerPrivateKey: "unused",
    client: transactionClient({ simulate: async () => { throw new Error("revert"); } }),
    buyerWallet: {
      ...signer,
      async writeContract() { writes += 1; return txHash; },
    },
  });
  await assert.rejects(failedSimulation.assign(job, workerAddress), /CHAIN_MUTATION_SIMULATION_FAILED/);
  assert.equal(writes, 0);
});

test("worker claims relay only a signed Sepolia claim for the matching worker", async () => {
  const calls: ContractCall[] = [];
  const broadcasts: Hex[] = [];
  const workerAccount = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
  const signedTransaction = await workerAccount.signTransaction({
    chainId: 11155111,
    nonce: 0,
    to: "0x3333333333333333333333333333333333333333",
    value: 0n,
    gas: 100_000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    data: encodeFunctionData({
      abi: parseAbi(["function claim(bytes32 jobId)"]),
      functionName: "claim",
      args: [job.chainJobId as Hex],
    }),
  });
  const writer = new SepoliaEscrowWriter({
    rpcUrl: "https://rpc.invalid",
    escrowAddress: "0x3333333333333333333333333333333333333333",
    buyerPrivateKey: "unused",
    client: transactionClient({
      simulate: async (call) => { calls.push(call); return { request: call }; },
      broadcast: async (raw) => { broadcasts.push(raw); return keccak256(raw); },
    }),
    buyerWallet: wallet(buyerAddress, []),
  });

  await writer.claim(job, workerAccount.address, signedTransaction);
  assert.equal(calls[0]?.functionName, "claim");
  assert.equal(calls[0]?.account, workerAccount.address);
  assert.deepEqual(broadcasts, [signedTransaction]);
  await assert.rejects(writer.claim(job, "0x4444444444444444444444444444444444444444", signedTransaction), /WORKER_CLAIM_TRANSACTION_INVALID/);
});

test("writer rejects a buyer key that does not match the imported job", async () => {
  const writer = new SepoliaEscrowWriter({
    rpcUrl: "https://rpc.invalid",
    escrowAddress: "0x3333333333333333333333333333333333333333",
    buyerPrivateKey: "unused",
    client: transactionClient(),
    buyerWallet: wallet("0x5555555555555555555555555555555555555555", []),
  });
  await assert.rejects(writer.assign(job, workerAddress), /CHAIN_BUYER_SIGNER_MISMATCH/);
});

function wallet(address: Address, writes: unknown[]): SepoliaContractWallet {
  return {
    address,
    async writeContract(request) { writes.push(request); return txHash; },
  };
}

function transactionClient(options: {
  chainId?: number;
  simulate?: (call: ContractCall) => Promise<{ request: unknown }>;
  broadcast?: (raw: Hex) => Promise<Hex>;
  wait?: (input: { hash: Hex; confirmations: number }) => Promise<{ status: "success" | "reverted" }>;
} = {}): SepoliaTransactionClient {
  return {
    async getChainId() { return options.chainId ?? 11155111; },
    async simulateContract(call) { return options.simulate ? options.simulate(call) : { request: call }; },
    async broadcastTransaction(raw) { return options.broadcast ? options.broadcast(raw) : txHash; },
    async waitForTransactionReceipt(input) { return options.wait ? options.wait(input) : { status: "success" }; },
  };
}
