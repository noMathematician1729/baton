import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  deserialise,
  type GatewayOperation,
  type Hex,
  type OperationState,
  serialise,
  type ServicePolicy,
} from "../../protocol/v1.js";

export type LedgerBalance = {
  deposits: bigint;
  available: bigint;
  reserved: bigint;
  settledSpend: bigint;
  returnedFunds: bigint;
};

type LedgerFile = {
  version: 1;
  budgets: Record<string, { policy: ServicePolicy; balance: LedgerBalance }>;
  operations: Record<string, GatewayOperation>;
};

export type ReserveRequest = {
  operationId: string;
  jobId: string;
  taskId: string;
  worker: Hex;
  epoch: number;
  service: string;
  inputDigest: Hex;
  requestFingerprint: Hex;
  amount: bigint;
  asset: string;
  nonce: string;
};

export type SettledOperation = {
  providerReceipt: string;
  outputDigest?: Hex;
  outputRef?: string;
};

/**
 * A small durable ledger with the same transactional boundary required by the
 * production adapter. Writes are atomic (temp file + rename) and serialized in
 * process. A future SQLite adapter can implement this interface without changing
 * gateway or worker code.
 */
export class OperationLedger {
  private readonly filePath: string;
  private state: LedgerFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  public async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.state = deserialise<LedgerFile>(await JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { version: 1, budgets: {}, operations: {} };
      await this.persist();
    }
  }

  public async reset(): Promise<void> {
    await this.mutate((state) => {
      state.budgets = {};
      state.operations = {};
    });
  }

  public async configureBudget(jobId: string, policy: ServicePolicy): Promise<LedgerBalance> {
    return this.mutate((state) => {
      const current = state.budgets[jobId];
      if (current) {
        if (current.policy.asset !== policy.asset || current.policy.budget !== policy.budget) {
          throw new Error("BUDGET_IMMUTABLE: service policy cannot be rewritten after funding");
        }
        return current.balance;
      }
      const balance = {
        deposits: policy.budget,
        available: policy.budget,
        reserved: 0n,
        settledSpend: 0n,
        returnedFunds: 0n,
      } satisfies LedgerBalance;
      state.budgets[jobId] = { policy, balance };
      return balance;
    });
  }

  public async reserve(request: ReserveRequest): Promise<GatewayOperation> {
    return this.mutate((state) => {
      const existing = state.operations[request.operationId];
      if (existing) {
        if (existing.requestFingerprint !== request.requestFingerprint) {
          throw new Error("OPERATION_KEY_REUSED: operation ID has a different request fingerprint");
        }
        return existing;
      }
      const budget = state.budgets[request.jobId];
      if (!budget) throw new Error("BUDGET_NOT_CONFIGURED");
      if (budget.policy.asset !== request.asset) throw new Error("ASSET_NOT_APPROVED");
      if (!budget.policy.approvedServices.includes(request.service)) throw new Error("SERVICE_NOT_APPROVED");
      if (request.amount <= 0n || request.amount > budget.policy.perRequestCap) {
        throw new Error("REQUEST_CAP_EXCEEDED");
      }
      if (budget.balance.available < request.amount) throw new Error("BUDGET_EXHAUSTED");
      budget.balance.available -= request.amount;
      budget.balance.reserved += request.amount;
      const timestamp = new Date().toISOString();
      const operation: GatewayOperation = {
        ...request,
        state: "RESERVED",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.operations[request.operationId] = operation;
      return operation;
    });
  }

  public async transition(operationId: string, next: OperationState, patch: Partial<GatewayOperation> = {}): Promise<GatewayOperation> {
    return this.mutate((state) => {
      const operation = state.operations[operationId];
      if (!operation) throw new Error("OPERATION_NOT_FOUND");
      assertTransition(operation.state, next);
      const budget = state.budgets[operation.jobId];
      if (!budget) throw new Error("BUDGET_NOT_CONFIGURED");
      if (next === "SETTLED") {
        budget.balance.reserved -= operation.amount;
        budget.balance.settledSpend += operation.amount;
      } else if (next === "FAILED") {
        budget.balance.reserved -= operation.amount;
        budget.balance.available += operation.amount;
        budget.balance.returnedFunds += operation.amount;
      }
      operation.state = next;
      operation.updatedAt = new Date().toISOString();
      Object.assign(operation, patch);
      return operation;
    });
  }

  public async getOperation(operationId: string): Promise<GatewayOperation | undefined> {
    await this.ready();
    const operation = this.state?.operations[operationId];
    return operation ? structuredClone(operation) : undefined;
  }

  public async listOperations(jobId: string): Promise<GatewayOperation[]> {
    await this.ready();
    return Object.values(this.state?.operations ?? {})
      .filter((operation) => operation.jobId === jobId)
      .map((operation) => structuredClone(operation));
  }

  public async getBalance(jobId: string): Promise<LedgerBalance | undefined> {
    await this.ready();
    const balance = this.state?.budgets[jobId]?.balance;
    return balance ? structuredClone(balance) : undefined;
  }

  public async getPolicy(jobId: string): Promise<ServicePolicy | undefined> {
    await this.ready();
    const policy = this.state?.budgets[jobId]?.policy;
    return policy ? structuredClone(policy) : undefined;
  }

  private async mutate<T>(fn: (state: LedgerFile) => T): Promise<T> {
    const task = this.queue.then(async () => {
      await this.ready();
      const state = this.state as LedgerFile;
      const result = fn(state);
      await this.persist();
      return structuredClone(result);
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async ready(): Promise<void> {
    if (!this.state) await this.init();
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(serialise(this.state), null, 2), "utf8");
    await rename(temporary, this.filePath);
  }
}

const transitions: Record<OperationState, OperationState[]> = {
  INTENT: ["RESERVED", "FAILED", "UNKNOWN"],
  RESERVED: ["SUBMITTED", "FAILED", "UNKNOWN"],
  SUBMITTED: ["SETTLED", "FAILED", "UNKNOWN"],
  SETTLED: ["OUTPUT_AVAILABLE", "UNKNOWN"],
  OUTPUT_AVAILABLE: [],
  FAILED: [],
  UNKNOWN: ["SUBMITTED", "SETTLED", "FAILED", "OUTPUT_AVAILABLE"],
};

function assertTransition(current: OperationState, next: OperationState): void {
  if (!transitions[current].includes(next)) {
    throw new Error(`INVALID_OPERATION_TRANSITION: ${current} -> ${next}`);
  }
}
