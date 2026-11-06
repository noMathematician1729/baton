import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { nowIso, type CoreStore, type OperationRecord } from "./coreStore.js";

/** The two wallet operations the journal needs; injectable for offline tests. */
export type JournalWallet = {
  prepareTransactionRequest(args: never): Promise<unknown>;
  signTransaction(args: never): Promise<Hex>;
};

export type TxRequest = { to?: Address; data: Hex; value?: bigint; gas?: bigint };
export type Scope = { jobId?: Hex };

/**
 * Buyer-side Sepolia writer with a persistent operation journal.
 *
 * Each transaction is simulated, signed locally, and its hash and raw bytes are
 * persisted *before* broadcast. On retry the journal reconciles the recorded hash
 * (receipt, or rebroadcast of the identical signed bytes) rather than creating a
 * new transaction, so a crash between broadcast and persistence cannot duplicate
 * funding, assignment, takeover, or payouts.
 */
export class JournaledChain {
  public readonly publicClient: PublicClient;
  public readonly account: PrivateKeyAccount;
  private readonly walletClient: JournalWallet;
  private sendQueue: Promise<unknown> = Promise.resolve();
  public simulationAttempts = 6;
  public simulationRetryMs = 5000;

  public constructor(
    private readonly store: CoreStore,
    rpcUrl: string,
    buyerPrivateKey: Hex,
    public readonly confirmations = 2,
    clients: { publicClient?: PublicClient; walletClient?: JournalWallet } = {},
  ) {
    this.account = privateKeyToAccount(buyerPrivateKey);
    this.publicClient = clients.publicClient ?? (createPublicClient({ chain: sepolia, transport: http(rpcUrl) }) as PublicClient);
    this.walletClient = clients.walletClient ?? (createWalletClient({ account: this.account, chain: sepolia, transport: http(rpcUrl) }) as unknown as JournalWallet);
  }

  public async getOp(scope: Scope, key: string): Promise<OperationRecord | undefined> {
    return this.store.read((s) => (scope.jobId ? s.jobs[scope.jobId]?.ops[key] : s.globalOps[key]));
  }

  public async setOp(scope: Scope, key: string, patch: Partial<OperationRecord> & Pick<OperationRecord, "intent" | "network">): Promise<OperationRecord> {
    return this.store.mutate((s) => {
      const ops = scope.jobId ? s.jobs[scope.jobId]!.ops : s.globalOps;
      const next: OperationRecord = { ...(ops[key] ?? { key, status: "pending" }), ...patch, key, updatedAt: nowIso() } as OperationRecord;
      ops[key] = next;
      return next;
    });
  }

  /**
   * Execute `request` once for `key`. `alreadyDone` lets callers detect state that
   * already exists on-chain (for example a CREATE2 proxy or a granted role) so a
   * lost journal entry still does not cause a duplicate write.
   */
  public async run(
    scope: Scope,
    key: string,
    intent: string,
    build: () => Promise<TxRequest>,
    options: { alreadyDone?: () => Promise<Record<string, unknown> | undefined>; onReceipt?: (receipt: TransactionReceipt) => Record<string, unknown> } = {},
  ): Promise<OperationRecord> {
    const existing = await this.getOp(scope, key);
    if (existing?.status === "confirmed" || existing?.status === "skipped") return existing;
    if (existing?.status === "submitted" && existing.txHash) {
      return this.reconcile(scope, key, existing, options.onReceipt);
    }
    const done = await options.alreadyDone?.();
    if (done) return this.setOp(scope, key, { intent, network: "sepolia", status: "skipped", result: { ...done, reason: "already present on-chain" } });
    await this.setOp(scope, key, { intent, network: "sepolia", status: "pending", error: undefined });
    // Serialize signing so concurrent operations never race on the buyer nonce.
    const signed = await (this.sendQueue = this.sendQueue.catch(() => undefined).then(async () => {
      // Load-balanced RPC nodes can lag the block that confirmed a prerequisite
      // (for example funding before assignment), so a revert is re-simulated before failing.
      let request = await build();
      for (let attempt = 1; ; attempt++) {
        try {
          await this.publicClient.call({ account: this.account.address, to: request.to, data: request.data, value: request.value });
          break;
        } catch (error) {
          if (attempt >= this.simulationAttempts) throw new Error(`simulation reverted for ${key}: ${(error as Error & { shortMessage?: string }).shortMessage ?? (error as Error).message}`);
          await new Promise((ok) => setTimeout(ok, this.simulationRetryMs));
          request = await build();
        }
      }
      const prepared = await this.walletClient.prepareTransactionRequest({ account: this.account, chain: sepolia, to: request.to ?? null, data: request.data, value: request.value, gas: request.gas } as never);
      const rawTx = await this.walletClient.signTransaction(prepared as never);
      const txHash = keccak256(rawTx);
      await this.setOp(scope, key, { intent, network: "sepolia", status: "submitted", txHash, rawTx });
      await this.publicClient.sendRawTransaction({ serializedTransaction: rawTx }).catch((error: Error) => {
        if (!/already known|nonce too low/i.test(error.message)) throw error;
      });
      return { txHash, rawTx };
    }) as Promise<{ txHash: Hex; rawTx: Hex }>);
    const submitted = await this.getOp(scope, key);
    return this.reconcile(scope, key, { ...submitted!, txHash: signed.txHash }, options.onReceipt);
  }

  private async reconcile(scope: Scope, key: string, op: OperationRecord, onReceipt?: (receipt: TransactionReceipt) => Record<string, unknown>): Promise<OperationRecord> {
    const hash = op.txHash!;
    let receipt = await this.publicClient.getTransactionReceipt({ hash }).catch(() => undefined);
    if (!receipt) {
      const known = await this.publicClient.getTransaction({ hash }).catch(() => undefined);
      if (!known && op.rawTx) {
        await this.publicClient.sendRawTransaction({ serializedTransaction: op.rawTx }).catch((error: Error) => {
          if (!/already known|nonce too low/i.test(error.message)) throw error;
        });
      }
      receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: this.confirmations, timeout: 300_000 });
    } else {
      await this.publicClient.waitForTransactionReceipt({ hash, confirmations: this.confirmations, timeout: 300_000 });
    }
    if (receipt.status !== "success") {
      return this.setOp(scope, key, { intent: op.intent, network: "sepolia", status: "failed", error: "transaction reverted", result: { block: receipt.blockNumber.toString() } });
    }
    const result = { block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), ...(receipt.contractAddress ? { contractAddress: receipt.contractAddress } : {}), ...(onReceipt?.(receipt) ?? {}) };
    return this.setOp(scope, key, { intent: op.intent, network: "sepolia", status: "confirmed", rawTx: undefined, result });
  }
}

export function assertConfirmed(op: OperationRecord): OperationRecord {
  if (op.status !== "confirmed" && op.status !== "skipped") throw new Error(`${op.key} ${op.status}: ${op.error ?? ""}`);
  return op;
}
