import { randomUUID } from "node:crypto";
import { digest, type GatewayOperation, type Hex, type JobSnapshot } from "../../protocol/v1.js";
import { OperationLedger, type LedgerBalance } from "../ledger/operationLedger.js";
import { JobStore } from "../../domain/jobs/jobStore.js";

export type PaymentRequest = {
  operationId: string;
  jobId: string;
  taskId: string;
  worker: Hex;
  epoch: number;
  service: string;
  inputDigest: Hex;
  amount: bigint;
  asset: string;
};

export type PaymentResult = {
  providerReceipt: string;
  outputDigest: Hex;
  outputRef: string;
};

export interface PaymentProvider {
  submit(request: PaymentRequest): Promise<PaymentResult>;
  reconcile(operation: GatewayOperation): Promise<PaymentResult | { settled: false }>;
}

export class LocalPaymentProvider implements PaymentProvider {
  private readonly settled = new Map<string, PaymentResult>();

  public async submit(request: PaymentRequest): Promise<PaymentResult> {
    const existing = this.settled.get(request.operationId);
    if (existing) return existing;
    const result = {
      providerReceipt: `local-hedera-receipt:${request.operationId}`,
      outputDigest: digest({ operationId: request.operationId, inputDigest: request.inputDigest, service: request.service }),
      outputRef: `local://paid-output/${request.operationId}`,
    } satisfies PaymentResult;
    this.settled.set(request.operationId, result);
    return result;
  }

  public async reconcile(operation: GatewayOperation): Promise<PaymentResult | { settled: false }> {
    return this.settled.get(operation.operationId) ?? { settled: false };
  }
}

export class Gateway {
  public constructor(
    private readonly jobs: JobStore,
    private readonly ledger: OperationLedger,
    private readonly provider: PaymentProvider,
  ) {}

  public async quote(jobId: string, service: string, amount: bigint): Promise<{ approved: boolean; reason?: string; balance?: LedgerBalance }> {
    const job = await this.requireJob(jobId);
    const balance = await this.ledger.getBalance(jobId);
    const policy = job.servicePolicy;
    if (!policy.approvedServices.includes(service)) return { approved: false, reason: "SERVICE_NOT_APPROVED", balance };
    if (amount <= 0n || amount > policy.perRequestCap) return { approved: false, reason: "REQUEST_CAP_EXCEEDED", balance };
    if (!balance || balance.available < amount) return { approved: false, reason: "BUDGET_EXHAUSTED", balance };
    return { approved: true, balance };
  }

  public async execute(request: PaymentRequest): Promise<GatewayOperation> {
    const job = await this.requireJob(request.jobId);
    this.assertAdmission(job, request.worker, request.epoch);
    const fingerprint = digest({ ...request, amount: request.amount.toString() });
    const operation = await this.ledger.reserve({
      ...request,
      requestFingerprint: fingerprint,
      nonce: randomUUID(),
    });
    if (operation.state === "OUTPUT_AVAILABLE") return operation;
    if (operation.state !== "RESERVED") return this.reconcileForRetry(operation);

    try {
      await this.ledger.transition(operation.operationId, "SUBMITTED");
    } catch (error) {
      const current = await this.ledger.getOperation(operation.operationId);
      if (current && current.state !== "RESERVED") return this.reconcileForRetry(current);
      throw error;
    }

    let result: PaymentResult;
    try {
      result = await this.provider.submit(request);
    } catch (error) {
      const current = await this.ledger.getOperation(operation.operationId);
      if (current?.state === "SUBMITTED") {
        await this.ledger.transition(operation.operationId, "UNKNOWN", {
          failureCode: error instanceof Error ? error.message : "PAYMENT_UNKNOWN",
        });
      }
      throw new Error("PAYMENT_UNKNOWN: operation is held for reconciliation");
    }

    const current = await this.ledger.getOperation(operation.operationId);
    if (!current) throw new Error("OPERATION_NOT_FOUND");
    if (current.state === "OUTPUT_AVAILABLE") return current;
    if (current.state === "SETTLED") return this.ledger.transition(operation.operationId, "OUTPUT_AVAILABLE", result);
    if (current.state !== "SUBMITTED" && current.state !== "UNKNOWN") {
      throw new Error(`PAYMENT_STATE_UNEXPECTED: ${current.state}`);
    }
    try {
      await this.ledger.transition(operation.operationId, "SETTLED", result);
    } catch (error) {
      const latest = await this.ledger.getOperation(operation.operationId);
      if (latest?.state === "OUTPUT_AVAILABLE") return latest;
      if (latest?.state === "SETTLED") return this.ledger.transition(operation.operationId, "OUTPUT_AVAILABLE", result);
      if (latest?.state === "SUBMITTED") {
        await this.ledger.transition(operation.operationId, "UNKNOWN", {
          failureCode: error instanceof Error ? error.message : "SETTLEMENT_RECORDING_FAILED",
        });
      }
      throw new Error("PAYMENT_UNKNOWN: settlement could not be recorded");
    }
    const settled = await this.ledger.getOperation(operation.operationId);
    if (settled?.state === "OUTPUT_AVAILABLE") return settled;
    return this.ledger.transition(operation.operationId, "OUTPUT_AVAILABLE", result);
  }

  public async reconcile(operationId: string): Promise<GatewayOperation> {
    const operation = await this.ledger.getOperation(operationId);
    if (!operation) throw new Error("OPERATION_NOT_FOUND");
    if (operation.state === "OUTPUT_AVAILABLE") return operation;
    const result = await this.provider.reconcile(operation);
    if (!isSettledResult(result)) {
      if (operation.state === "UNKNOWN") throw new Error("PAYMENT_STILL_UNKNOWN: reservation remains held");
      return operation;
    }
    const latest = await this.ledger.getOperation(operationId);
    if (!latest) throw new Error("OPERATION_NOT_FOUND");
    if (latest.state === "OUTPUT_AVAILABLE") return latest;
    if (latest.state !== "SETTLED") {
      if (latest.state !== "UNKNOWN" && latest.state !== "SUBMITTED") {
        throw new Error(`CANNOT_RECONCILE_OPERATION: ${latest.state}`);
      }
      try {
        await this.ledger.transition(operationId, "SETTLED", result);
      } catch (error) {
        const current = await this.ledger.getOperation(operationId);
        if (current?.state === "OUTPUT_AVAILABLE") return current;
        if (current?.state !== "SETTLED") throw error;
      }
    }
    const settled = await this.ledger.getOperation(operationId);
    if (!settled) throw new Error("OPERATION_NOT_FOUND");
    if (settled.state === "OUTPUT_AVAILABLE") return settled;
    return this.ledger.transition(operationId, "OUTPUT_AVAILABLE", result);
  }

  public async drain(jobId: string): Promise<JobSnapshot> {
    return this.jobs.drain(jobId);
  }

  public async resume(jobId: string): Promise<JobSnapshot> {
    const job = await this.requireJob(jobId);
    if (!job.task.assignedWorker) throw new Error("WORKER_NOT_ASSIGNED");
    return this.jobs.resume(jobId);
  }

  private async requireJob(jobId: string): Promise<JobSnapshot> {
    const job = await this.jobs.get(jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    return job;
  }

  private async reconcileForRetry(operation: GatewayOperation): Promise<GatewayOperation> {
    if (operation.state === "FAILED") throw new Error("PAYMENT_FAILED: operation is final");
    try {
      const reconciled = await this.reconcile(operation.operationId);
      if (reconciled.state === "OUTPUT_AVAILABLE") return reconciled;
      if (reconciled.state === "SUBMITTED") {
        await this.ledger.transition(operation.operationId, "UNKNOWN", {
          failureCode: "PAYMENT_RECONCILIATION_PENDING",
        });
      } else if (reconciled.state === "SETTLED") {
        throw new Error("PAID_OUTPUT_NOT_AVAILABLE: do not submit this operation again");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("PAYMENT_STILL_UNKNOWN")) throw error;
      const current = await this.ledger.getOperation(operation.operationId);
      if (current?.state === "OUTPUT_AVAILABLE") return current;
      if (current?.state === "SETTLED") {
        throw new Error("PAID_OUTPUT_NOT_AVAILABLE: do not submit this operation again");
      }
      throw error;
    }
    throw new Error("PAYMENT_STILL_UNKNOWN: reservation remains held");
  }

  private assertAdmission(job: JobSnapshot, worker: Hex, epoch: number): void {
    if (job.task.assignedWorker !== worker) throw new Error("WORKER_NOT_ASSIGNED");
    if (job.task.epoch !== epoch) throw new Error("STALE_EPOCH");
    if (job.task.drained || job.task.status !== "FUNDED") throw new Error("GATEWAY_DRAINED");
  }
}

function isSettledResult(result: PaymentResult | { settled: false }): result is PaymentResult {
  return !('settled' in result);
}
