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
    const operation = await this.ledger.reserve({ ...request, requestFingerprint: fingerprint, nonce: `${Date.now()}` });
    if (operation.state === "OUTPUT_AVAILABLE" || operation.state === "SETTLED") return operation;
    try {
      await this.ledger.transition(operation.operationId, "SUBMITTED");
      const result = await this.provider.submit(request);
      await this.ledger.transition(operation.operationId, "SETTLED", result);
      return this.ledger.transition(operation.operationId, "OUTPUT_AVAILABLE", result);
    } catch (error) {
      await this.ledger.transition(operation.operationId, "UNKNOWN", { failureCode: error instanceof Error ? error.message : "PAYMENT_UNKNOWN" });
      throw new Error("PAYMENT_UNKNOWN: operation is held for reconciliation");
    }
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
    if (operation.state === "UNKNOWN") await this.ledger.transition(operationId, "SUBMITTED");
    if (operation.state !== "SETTLED") await this.ledger.transition(operationId, "SETTLED", result);
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

  private assertAdmission(job: JobSnapshot, worker: Hex, epoch: number): void {
    if (job.task.assignedWorker !== worker) throw new Error("WORKER_NOT_ASSIGNED");
    if (job.task.epoch !== epoch) throw new Error("STALE_EPOCH");
    if (job.task.drained || job.task.status !== "FUNDED") throw new Error("GATEWAY_DRAINED");
  }
}

function isSettledResult(result: PaymentResult | { settled: false }): result is PaymentResult {
  return !('settled' in result);
}
