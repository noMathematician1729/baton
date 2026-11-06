import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  deserialise,
  digest,
  normalizeServicePolicy,
  paymentIntentFingerprint,
  type GatewayOperation,
  type Hex,
  type JobSnapshot,
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
  providerId: string;
  network: string;
  payee: Hex;
  policyVersion: string;
  approvedPolicyHash: Hex;
  amount: bigint;
  asset: string;
  nonce: string;
};

export type PendingJobProvision = {
  job: JobSnapshot;
  state: "PENDING";
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
      db.exec("DELETE FROM operations; DELETE FROM job_provisioning; DELETE FROM budgets; DELETE FROM auth_nonces;");
    });
  }

  public async consumeAuthNonce(scope: string, nonce: Hex, expiresAt: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error("ACTION_SIGNATURE_EXPIRED");
    this.transaction((db) => {
      db.prepare("DELETE FROM auth_nonces WHERE expires_at <= ?").run(now);
      const result = db.prepare(`
        INSERT OR IGNORE INTO auth_nonces (scope, nonce, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(scope, nonce, expiresAt, new Date().toISOString());
      if (result.changes !== 1) throw new Error("ACTION_NONCE_REPLAYED");
    });
  }

  public async configureBudget(jobId: string, policy: ServicePolicy): Promise<LedgerBalance> {
    return this.transaction((db) => this.ensureBudget(db, jobId, policy));
  }

  /** Durable first phase for creating the JSON job and its SQLite budget as one recoverable operation. */
  public async beginJobProvision(job: JobSnapshot): Promise<void> {
    this.transaction((db) => {
      const jobId = job.terms.jobId;
      const snapshotJson = json(job);
      const existing = db.prepare("SELECT snapshot_json FROM job_provisioning WHERE job_id = ?").get(jobId) as
        | { snapshot_json: string }
        | undefined;
      if (existing) {
        if (existing.snapshot_json !== snapshotJson) throw new Error("JOB_PROVISIONING_CONFLICT");
        return;
      }
      const timestamp = new Date().toISOString();
      db.prepare(`
        INSERT INTO job_provisioning (job_id, snapshot_json, state, created_at, updated_at)
        VALUES (?, ?, 'PENDING', ?, ?)
      `).run(jobId, snapshotJson, timestamp, timestamp);
    });
  }

  public async pendingJobProvisions(): Promise<PendingJobProvision[]> {
    const rows = this.database().prepare(`
      SELECT snapshot_json FROM job_provisioning WHERE state = 'PENDING' ORDER BY created_at, job_id
    `).all() as Array<{ snapshot_json: string }>;
    return rows.map((row) => ({ job: parseJson<JobSnapshot>(row.snapshot_json), state: "PENDING" }));
  }

  /** Commits the budget and journal completion together, after the JSON snapshot is durable. */
  public async completeJobProvision(job: JobSnapshot): Promise<LedgerBalance> {
    return this.transaction((db) => {
      const jobId = job.terms.jobId;
      const record = db.prepare("SELECT snapshot_json, state FROM job_provisioning WHERE job_id = ?").get(jobId) as
        | { snapshot_json: string; state: string }
        | undefined;
      if (!record || record.snapshot_json !== json(job)) throw new Error("JOB_PROVISIONING_RECORD_MISSING");
      const balance = this.ensureBudget(db, jobId, job.servicePolicy);
      db.prepare("UPDATE job_provisioning SET state = 'COMPLETE', updated_at = ? WHERE job_id = ?")
        .run(new Date().toISOString(), jobId);
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
        if (operation.jobId !== request.jobId) {
          throw new Error("OPERATION_KEY_REUSED: operation ID belongs to a different job");
        }
        const budget = db.prepare("SELECT policy_json FROM budgets WHERE job_id = ?").get(operation.jobId) as
          | { policy_json: string }
          | undefined;
        if (!budget) throw new Error("BUDGET_NOT_CONFIGURED");
        let changed = false;
        if (operation.requestFingerprint !== request.requestFingerprint) {
          // Migrate legacy worker-scoped and context-free stable fingerprints
          // only when the immutable budget policy still matches this request.
          if (!samePaymentIntent(operation, request)
            || (operation.requestFingerprint !== legacyGatewayFingerprint(operation)
              && operation.requestFingerprint !== previousStablePaymentFingerprint(operation))
            || request.requestFingerprint !== stablePaymentFingerprint(request)) {
            throw new Error("OPERATION_KEY_REUSED: operation ID has a different request fingerprint");
          }
          operation.requestFingerprint = request.requestFingerprint;
          changed = true;
        }
        assertRequestPolicyContext(normalizeServicePolicy(parseJson<Partial<ServicePolicy>>(budget.policy_json)), request);
        changed ||= operation.providerId !== request.providerId
          || operation.network !== request.network
          || operation.payee?.toLowerCase() !== request.payee.toLowerCase()
          || operation.policyVersion !== request.policyVersion
          || operation.approvedPolicyHash !== request.approvedPolicyHash;
        if (!changed) return operation;
        operation.providerId = request.providerId;
        operation.network = request.network;
        operation.payee = request.payee;
        operation.policyVersion = request.policyVersion;
        operation.approvedPolicyHash = request.approvedPolicyHash;
        operation.updatedAt = new Date().toISOString();
        db.prepare("UPDATE operations SET request_fingerprint = ?, operation_json = ?, updated_at = ? WHERE operation_id = ?")
          .run(operation.requestFingerprint, json(operation), operation.updatedAt, operation.operationId);
        return operation;
      }

      const row = this.budgetRow(db, request.jobId);
      const policy = normalizeServicePolicy(parseJson<Partial<ServicePolicy>>(row.policy_json));
      assertRequestPolicyContext(policy, request);
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
      this.assertJobAccounting(db, operation.jobId);
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

      if (next === "SETTLED") {
        if (operation.providerReceipt) throw new Error("SETTLEMENT_ALREADY_RECORDED");
        if (!patch.providerReceipt?.trim()) throw new Error("PROVIDER_RECEIPT_REQUIRED");
      }
      if (next === "FAILED" && operation.providerReceipt) {
        throw new Error("SETTLED_OPERATION_CANNOT_FAIL");
      }
      if (next === "OUTPUT_AVAILABLE") {
        const outputDigest = patch.outputDigest ?? operation.outputDigest;
        const outputRef = patch.outputRef ?? operation.outputRef;
        if (!operation.providerReceipt) throw new Error("SETTLEMENT_REQUIRED_FOR_OUTPUT");
        if (!outputDigest || !/^0x[\da-f]{64}$/i.test(outputDigest)) throw new Error("OUTPUT_DIGEST_REQUIRED");
        if (!outputRef?.trim()) throw new Error("OUTPUT_REFERENCE_REQUIRED");
      }
      if (next !== "SETTLED" && patch.providerReceipt !== undefined) {
        throw new Error("PROVIDER_RECEIPT_STATE_MISMATCH");
      }
      if (next !== "OUTPUT_AVAILABLE" && (patch.outputDigest !== undefined || patch.outputRef !== undefined)) {
        throw new Error("OUTPUT_STATE_MISMATCH");
      }

      if (next === "SETTLED" || next === "FAILED") {
        const balance = balanceFromRow(this.budgetRow(db, operation.jobId));
        if (balance.reserved < operation.amount) throw new Error("LEDGER_INVARIANT_BROKEN");
        balance.reserved -= operation.amount;
        if (next === "SETTLED") balance.settledSpend += operation.amount;
        else balance.available += operation.amount;
        this.writeBalance(db, operation.jobId, balance);
      }

      Object.assign(operation, patch);
      operation.state = next;
      operation.updatedAt = new Date().toISOString();
      db.prepare(`
        UPDATE operations SET state = ?, operation_json = ?, updated_at = ? WHERE operation_id = ?
      `).run(next, json(operation), operation.updatedAt, operationId);
      this.recordEvent(db, operationId, previousState, next, patch);
      this.assertJobAccounting(db, operation.jobId);
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
    return row ? normalizeServicePolicy(parseJson<Partial<ServicePolicy>>(row.policy_json)) : undefined;
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
        CREATE TABLE IF NOT EXISTS auth_nonces (
          scope TEXT NOT NULL,
          nonce TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (scope, nonce)
        ) STRICT, WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS job_provisioning (
          job_id TEXT PRIMARY KEY,
          snapshot_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('PENDING', 'COMPLETE')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
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

  private ensureBudget(db: DatabaseSync, jobId: string, policyInput: ServicePolicy): LedgerBalance {
    const policy = normalizeServicePolicy(policyInput);
    const policyJson = json(policy);
    const existing = db.prepare("SELECT policy_json FROM budgets WHERE job_id = ?").get(jobId) as
      | { policy_json: string }
      | undefined;
    if (existing) {
      if (json(normalizeServicePolicy(parseJson<Partial<ServicePolicy>>(existing.policy_json))) !== policyJson) {
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

  private assertJobAccounting(db: DatabaseSync, jobId: string): void {
    const balance = balanceFromRow(this.budgetRow(db, jobId));
    const rows = db.prepare("SELECT operation_json FROM operations WHERE job_id = ?").all(jobId) as OperationRow[];
    let reserved = 0n;
    let settled = 0n;
    for (const row of rows) {
      const operation = parseJson<GatewayOperation>(row.operation_json);
      if (operation.state === "RESERVED" || operation.state === "SUBMITTED" || operation.state === "UNKNOWN") {
        reserved += operation.amount;
      } else if (operation.state === "SETTLED" || operation.state === "OUTPUT_AVAILABLE") {
        settled += operation.amount;
      }
    }
    if (balance.reserved !== reserved || balance.settledSpend !== settled) {
      throw new Error("LEDGER_OPERATION_ACCOUNTING_MISMATCH");
    }
    if (balance.deposits !== balance.available + balance.reserved + balance.settledSpend + balance.returnedFunds) {
      throw new Error("LEDGER_BALANCE_CONSERVATION_BROKEN");
    }
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
    && existing.asset === request.asset
    && (existing.providerId === undefined || existing.providerId === request.providerId)
    && (existing.network === undefined || existing.network === request.network)
    && (existing.payee === undefined || existing.payee.toLowerCase() === request.payee.toLowerCase())
    && (existing.policyVersion === undefined || existing.policyVersion === request.policyVersion)
    && (existing.approvedPolicyHash === undefined || existing.approvedPolicyHash === request.approvedPolicyHash);
}

function stablePaymentFingerprint(request: ReserveRequest): Hex {
  return paymentIntentFingerprint(request);
}

function previousStablePaymentFingerprint(operation: GatewayOperation): Hex {
  return digest({
    jobId: operation.jobId,
    taskId: operation.taskId,
    service: operation.service,
    inputDigest: operation.inputDigest,
    amount: operation.amount.toString(),
    asset: operation.asset,
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

function assertRequestPolicyContext(policy: ServicePolicy, request: ReserveRequest): void {
  if (request.providerId !== policy.providerId
    || request.network !== policy.network
    || request.payee.toLowerCase() !== policy.payee.toLowerCase()
    || request.policyVersion !== policy.policyVersion
    || request.approvedPolicyHash.toLowerCase() !== digest(policy).toLowerCase()) {
    throw new Error("PAYMENT_POLICY_CONTEXT_MISMATCH");
  }
}

const transitions: Record<OperationState, OperationState[]> = {
  INTENT: ["RESERVED", "FAILED", "UNKNOWN"],
  RESERVED: ["SUBMITTED", "FAILED", "UNKNOWN"],
  SUBMITTED: ["SETTLED", "FAILED", "UNKNOWN"],
  SETTLED: ["OUTPUT_AVAILABLE"],
  OUTPUT_AVAILABLE: [],
  FAILED: [],
  UNKNOWN: ["SETTLED", "FAILED"],
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
