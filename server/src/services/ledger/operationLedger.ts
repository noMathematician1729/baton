import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  deserialise,
  digest,
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

type BudgetRow = {
  policy_json: string;
  deposits: string;
  available: string;
  reserved: string;
  settled_spend: string;
  returned_funds: string;
};

type OperationRow = { operation_json: string };
type OperationPatch = Partial<Pick<GatewayOperation, "providerReceipt" | "outputDigest" | "outputRef" | "failureCode" | "reusedBy">>;

/** Durable operation and service-budget ledger backed by the gateway's local SQLite database. */
export class OperationLedger {
  private db: DatabaseSync | undefined;

  public constructor(private readonly filePath: string) {}

  public async init(): Promise<void> {
    this.database();
  }

  public close(): void {
    this.db?.close();
    this.db = undefined;
  }

  public async reset(): Promise<void> {
    this.transaction((db) => {
      db.exec("DELETE FROM operations; DELETE FROM budgets;");
    });
  }

  public async configureBudget(jobId: string, policy: ServicePolicy): Promise<LedgerBalance> {
    return this.transaction((db) => {
      const policyJson = json(policy);
      const existing = db.prepare("SELECT policy_json FROM budgets WHERE job_id = ?").get(jobId) as
        | { policy_json: string }
        | undefined;
      if (existing) {
        if (existing.policy_json !== policyJson) {
          throw new Error("BUDGET_IMMUTABLE: service policy cannot be rewritten after funding");
        }
        return balanceFromRow(this.budgetRow(db, jobId));
      }

      const balance: LedgerBalance = {
        deposits: policy.budget,
        available: policy.budget,
        reserved: 0n,
        settledSpend: 0n,
        returnedFunds: 0n,
      };
      db.prepare(`
        INSERT INTO budgets (job_id, policy_json, deposits, available, reserved, settled_spend, returned_funds)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, policyJson, ...balanceValues(balance));
      return balance;
    });
  }

  public async reserve(request: ReserveRequest): Promise<GatewayOperation> {
    return this.transaction((db) => {
      const existing = db.prepare("SELECT operation_json FROM operations WHERE operation_id = ?").get(request.operationId) as
        | OperationRow
        | undefined;
      if (existing) {
        const operation = parseJson<GatewayOperation>(existing.operation_json);
        if (operation.requestFingerprint !== request.requestFingerprint) {
          // Migrate records written by the previous gateway fingerprint, which
          // included worker and epoch. New records require the stable intent
          // fingerprint and reject arbitrary operation-key reuse.
          if (!samePaymentIntent(operation, request)
            || operation.requestFingerprint !== legacyGatewayFingerprint(operation)
            || request.requestFingerprint !== stablePaymentFingerprint(request)) {
            throw new Error("OPERATION_KEY_REUSED: operation ID has a different request fingerprint");
          }
          operation.requestFingerprint = request.requestFingerprint;
          operation.updatedAt = new Date().toISOString();
          db.prepare("UPDATE operations SET request_fingerprint = ?, operation_json = ?, updated_at = ? WHERE operation_id = ?")
            .run(operation.requestFingerprint, json(operation), operation.updatedAt, operation.operationId);
        }
        return operation;
      }

      const row = this.budgetRow(db, request.jobId);
      const policy = parseJson<ServicePolicy>(row.policy_json);
      const balance = balanceFromRow(row);
      if (policy.asset !== request.asset) throw new Error("ASSET_NOT_APPROVED");
      if (!policy.approvedServices.includes(request.service)) throw new Error("SERVICE_NOT_APPROVED");
      if (request.amount <= 0n || request.amount > policy.perRequestCap) {
        throw new Error("REQUEST_CAP_EXCEEDED");
      }
      if (balance.available < request.amount) throw new Error("BUDGET_EXHAUSTED");

      balance.available -= request.amount;
      balance.reserved += request.amount;
      this.writeBalance(db, request.jobId, balance);

      const timestamp = new Date().toISOString();
      const operation: GatewayOperation = {
        ...request,
        state: "RESERVED",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      db.prepare(`
        INSERT INTO operations (operation_id, job_id, request_fingerprint, nonce, state, amount, operation_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.operationId,
        operation.jobId,
        operation.requestFingerprint,
        operation.nonce,
        operation.state,
        operation.amount.toString(),
        json(operation),
        operation.createdAt,
        operation.updatedAt,
      );
      this.recordEvent(db, operation.operationId, null, operation.state, {});
      return operation;
    });
  }

  public async transition(
    operationId: string,
    next: OperationState,
    patch: OperationPatch = {},
  ): Promise<GatewayOperation> {
    return this.transaction((db) => {
      const row = db.prepare("SELECT operation_json FROM operations WHERE operation_id = ?").get(operationId) as
        | OperationRow
        | undefined;
      if (!row) throw new Error("OPERATION_NOT_FOUND");
      const operation = parseJson<GatewayOperation>(row.operation_json);
      const previousState = operation.state;
      assertTransition(previousState, next);

      if (next === "SETTLED" || next === "FAILED") {
        const balance = balanceFromRow(this.budgetRow(db, operation.jobId));
        const alreadySettled = previousState === "SETTLED"
          || previousState === "OUTPUT_AVAILABLE"
          || Boolean(operation.providerReceipt);
        if (!alreadySettled) {
          if (balance.reserved < operation.amount) throw new Error("LEDGER_INVARIANT_BROKEN");
          balance.reserved -= operation.amount;
          if (next === "SETTLED") balance.settledSpend += operation.amount;
          else balance.available += operation.amount;
          this.writeBalance(db, operation.jobId, balance);
        }
      }

      Object.assign(operation, patch);
      operation.state = next;
      operation.updatedAt = new Date().toISOString();
      db.prepare(`
        UPDATE operations SET state = ?, operation_json = ?, updated_at = ? WHERE operation_id = ?
      `).run(next, json(operation), operation.updatedAt, operationId);
      this.recordEvent(db, operationId, previousState, next, patch);
      return operation;
    });
  }

  public async getOperation(operationId: string): Promise<GatewayOperation | undefined> {
    const row = this.database().prepare("SELECT operation_json FROM operations WHERE operation_id = ?").get(operationId) as
      | OperationRow
      | undefined;
    return row ? parseJson<GatewayOperation>(row.operation_json) : undefined;
  }

  public async listOperations(jobId: string): Promise<GatewayOperation[]> {
    const rows = this.database().prepare(`
      SELECT operation_json FROM operations WHERE job_id = ? ORDER BY created_at, operation_id
    `).all(jobId) as OperationRow[];
    return rows.map((row) => parseJson<GatewayOperation>(row.operation_json));
  }

  public async recordReuse(operationId: string, worker: Hex, epoch: number): Promise<GatewayOperation> {
    return this.transaction((db) => {
      const row = db.prepare("SELECT operation_json FROM operations WHERE operation_id = ?").get(operationId) as
        | OperationRow
        | undefined;
      if (!row) throw new Error("OPERATION_NOT_FOUND");
      const operation = parseJson<GatewayOperation>(row.operation_json);
      if (operation.state !== "OUTPUT_AVAILABLE") throw new Error("PAYMENT_OUTPUT_UNAVAILABLE");
      if (operation.worker.toLowerCase() === worker.toLowerCase() && operation.epoch === epoch) return operation;

      const reuses = operation.reusedBy ?? (operation.reusedBy = []);
      if (!reuses.some((reuse) => reuse.worker.toLowerCase() === worker.toLowerCase() && reuse.epoch === epoch)) {
        const reuse = { worker, epoch, at: new Date().toISOString() };
        reuses.push(reuse);
        operation.updatedAt = reuse.at;
        db.prepare("UPDATE operations SET operation_json = ?, updated_at = ? WHERE operation_id = ?")
          .run(json(operation), operation.updatedAt, operationId);
        this.recordEvent(db, operationId, operation.state, operation.state, { reusedBy: [reuse] });
      }
      return operation;
    });
  }

  public async getBalance(jobId: string): Promise<LedgerBalance | undefined> {
    const row = this.database().prepare(`
      SELECT deposits, available, reserved, settled_spend, returned_funds FROM budgets WHERE job_id = ?
    `).get(jobId) as Omit<BudgetRow, "policy_json"> | undefined;
    return row ? balanceFromRow(row) : undefined;
  }

  public async getPolicy(jobId: string): Promise<ServicePolicy | undefined> {
    const row = this.database().prepare("SELECT policy_json FROM budgets WHERE job_id = ?").get(jobId) as
      | { policy_json: string }
      | undefined;
    return row ? parseJson<ServicePolicy>(row.policy_json) : undefined;
  }

  private database(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.filePath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS budgets (
          job_id TEXT PRIMARY KEY,
          policy_json TEXT NOT NULL,
          deposits TEXT NOT NULL,
          available TEXT NOT NULL,
          reserved TEXT NOT NULL,
          settled_spend TEXT NOT NULL,
          returned_funds TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS operations (
          operation_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES budgets(job_id),
          request_fingerprint TEXT NOT NULL,
          nonce TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,
          amount TEXT NOT NULL,
          operation_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS operations_by_job ON operations(job_id, created_at);
        CREATE TABLE IF NOT EXISTS operation_events (
          event_id INTEGER PRIMARY KEY,
          operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE,
          from_state TEXT,
          to_state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          patch_json TEXT NOT NULL
        ) STRICT;
      `);
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private transaction<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(db);
      db.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private budgetRow(db: DatabaseSync, jobId: string): BudgetRow {
    const row = db.prepare(`
      SELECT policy_json, deposits, available, reserved, settled_spend, returned_funds
      FROM budgets WHERE job_id = ?
    `).get(jobId) as BudgetRow | undefined;
    if (!row) throw new Error("BUDGET_NOT_CONFIGURED");
    return row;
  }

  private writeBalance(db: DatabaseSync, jobId: string, balance: LedgerBalance): void {
    db.prepare(`
      UPDATE budgets SET available = ?, reserved = ?, settled_spend = ?, returned_funds = ? WHERE job_id = ?
    `).run(
      balance.available.toString(),
      balance.reserved.toString(),
      balance.settledSpend.toString(),
      balance.returnedFunds.toString(),
      jobId,
    );
  }

  private recordEvent(
    db: DatabaseSync,
    operationId: string,
    from: OperationState | null,
    to: OperationState,
    patch: OperationPatch,
  ): void {
    db.prepare(`
      INSERT INTO operation_events (operation_id, from_state, to_state, created_at, patch_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(operationId, from, to, new Date().toISOString(), json(patch));
  }
}

function samePaymentIntent(existing: GatewayOperation, request: ReserveRequest): boolean {
  return existing.jobId === request.jobId
    && existing.taskId === request.taskId
    && existing.service === request.service
    && existing.inputDigest === request.inputDigest
    && existing.amount === request.amount
    && existing.asset === request.asset;
}

function stablePaymentFingerprint(request: ReserveRequest): Hex {
  return digest({
    jobId: request.jobId,
    taskId: request.taskId,
    service: request.service,
    inputDigest: request.inputDigest,
    amount: request.amount.toString(),
    asset: request.asset,
  });
}

function legacyGatewayFingerprint(operation: GatewayOperation): Hex {
  return digest({
    operationId: operation.operationId,
    jobId: operation.jobId,
    taskId: operation.taskId,
    worker: operation.worker,
    epoch: operation.epoch,
    service: operation.service,
    inputDigest: operation.inputDigest,
    amount: operation.amount.toString(),
    asset: operation.asset,
  });
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

function json(value: unknown): string {
  return JSON.stringify(serialise(value));
}

function parseJson<T>(value: string): T {
  return deserialise<T>(JSON.parse(value));
}

function balanceFromRow(row: Omit<BudgetRow, "policy_json"> | BudgetRow): LedgerBalance {
  return {
    deposits: BigInt(row.deposits),
    available: BigInt(row.available),
    reserved: BigInt(row.reserved),
    settledSpend: BigInt(row.settled_spend),
    returnedFunds: BigInt(row.returned_funds),
  };
}

function balanceValues(balance: LedgerBalance): string[] {
  return [
    balance.deposits.toString(),
    balance.available.toString(),
    balance.reserved.toString(),
    balance.settledSpend.toString(),
    balance.returnedFunds.toString(),
  ];
}
