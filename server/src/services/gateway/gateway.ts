import { randomUUID } from "node:crypto";
import { digest, type CheckpointHead, type GatewayOperation, type Hex, type JobSnapshot } from "../../protocol/v1.js";
import type { ChainAdmission, JobAuthorityReader } from "../../chain/sepoliaAuthority.js";
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

export type PaymentReconciliation =
  | { status: "settled"; result: PaymentResult }
  | { status: "not-settled" }
  | { status: "unknown" };

export interface PaymentProvider {
  submit(request: PaymentRequest): Promise<PaymentResult>;
  reconcile(operation: GatewayOperation): Promise<PaymentReconciliation>;
}

export interface CheckpointAcceptanceVerifier {
  verifyCandidate(input: {
    job: JobSnapshot;
    acceptanceSpecHash: Hex;
    expectedHead: Hex;
    newHead: CheckpointHead;
  }): Promise<void>;
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

  public async reconcile(operation: GatewayOperation): Promise<PaymentReconciliation> {
    const result = this.settled.get(operation.operationId);
    return result ? { status: "settled", result } : { status: "not-settled" };
  }
}

export class Gateway {
  private readonly jobQueues = new Map<string, Promise<void>>();

  public constructor(
    private readonly jobs: JobStore,
    private readonly ledger: OperationLedger,
    private readonly provider: PaymentProvider,
    private readonly authority?: JobAuthorityReader,
    private readonly checkpointVerifier?: CheckpointAcceptanceVerifier,
  ) {}

  public get requiresChainAuthority(): boolean {
    return this.authority !== undefined;
  }

  public get lastConfirmedRead(): { blockNumber: bigint; blockHash: Hex; confirmationBlocks: number } | undefined {
    return this.authority?.lastConfirmedRead;
  }

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
    return this.withJobLock(request.jobId, async () => {
      const job = await this.requireJob(request.jobId);
      this.assertTaskId(job, request.taskId);
      await this.assertAdmission(job, request.worker, request.epoch);
      const fingerprint = paymentFingerprint(request);
      const operation = await this.ledger.reserve({
        ...request,
        requestFingerprint: fingerprint,
        nonce: randomUUID(),
      });

      if (operation.state !== "RESERVED") return this.reuseOrReconcile(operation, request);

      try {
        await this.ledger.transition(operation.operationId, "SUBMITTED");
      } catch (error) {
        const current = await this.ledger.getOperation(operation.operationId);
        if (current && current.state !== "RESERVED") return this.reuseOrReconcile(current, request);
        throw error;
      }

      let result: PaymentResult;
      try {
        result = await this.provider.submit(request);
      } catch {
        const latest = await this.ledger.getOperation(operation.operationId);
        if (latest?.state === "SUBMITTED") {
          try {
            await this.ledger.transition(operation.operationId, "UNKNOWN", { failureCode: "PAYMENT_OUTCOME_UNKNOWN" });
          } catch {
            // Preserve the last durable state; recovery will reconcile it before any retry.
          }
        }
        throw new Error("PAYMENT_UNKNOWN: operation is held for reconciliation");
      }

      let current = await this.ledger.getOperation(operation.operationId);
      if (!current) throw new Error("OPERATION_NOT_FOUND");
      if (current.state === "OUTPUT_AVAILABLE") return this.recordAuthorizedReuse(current, request);
      if (current.state === "SETTLED") {
        const available = await this.ledger.transition(operation.operationId, "OUTPUT_AVAILABLE", {
          outputDigest: result.outputDigest,
          outputRef: result.outputRef,
        });
        return this.recordAuthorizedReuse(available, request);
      }
      if (current.state !== "SUBMITTED" && current.state !== "UNKNOWN") {
        throw new Error(`PAYMENT_STATE_UNEXPECTED: ${current.state}`);
      }

      try {
        await this.ledger.transition(operation.operationId, "SETTLED", { providerReceipt: result.providerReceipt });
      } catch (error) {
        current = await this.ledger.getOperation(operation.operationId);
        if (current?.state === "OUTPUT_AVAILABLE") return this.recordAuthorizedReuse(current, request);
        if (current?.state !== "SETTLED") {
          if (current?.state === "SUBMITTED") {
            await this.ledger.transition(operation.operationId, "UNKNOWN", {
              failureCode: error instanceof Error ? error.message : "SETTLEMENT_RECORDING_FAILED",
            });
          }
          throw new Error("PAYMENT_UNKNOWN: settlement could not be recorded");
        }
      }

      current = await this.ledger.getOperation(operation.operationId);
      if (current?.state === "OUTPUT_AVAILABLE") return this.recordAuthorizedReuse(current, request);
      if (current?.state !== "SETTLED") throw new Error("PAYMENT_UNKNOWN: settlement state is not durable");
      const available = await this.ledger.transition(operation.operationId, "OUTPUT_AVAILABLE", {
        outputDigest: result.outputDigest,
        outputRef: result.outputRef,
      });
      return this.recordAuthorizedReuse(available, request);
    });
  }

  public async reconcile(operationId: string, worker: Hex, epoch: number): Promise<GatewayOperation> {
    const existing = await this.ledger.getOperation(operationId);
    if (!existing) throw new Error("OPERATION_NOT_FOUND");
    return this.withJobLock(existing.jobId, async () => {
      const job = await this.requireJob(existing.jobId);
      this.assertTaskId(job, existing.taskId);
      await this.assertAdmission(job, worker, epoch);
      const current = await this.ledger.getOperation(operationId);
      if (!current) throw new Error("OPERATION_NOT_FOUND");
      return this.reuseOrReconcile(current, { ...current, worker, epoch });
    });
  }

  public async assign(jobId: string, worker: Hex): Promise<JobSnapshot> {
    return this.withJobLock(jobId, async () => {
      const job = await this.requireJob(jobId);
      if (this.authority) {
        await this.authority.assertAssignedWorker(this.chainAdmission(job, worker, 1));
      }
      return this.jobs.assign(jobId, worker);
    });
  }

  public async acceptMilestone(input: {
    jobId: string;
    taskId: string;
    worker: Hex;
    epoch: number;
    acceptanceSpecHash: Hex;
    expectedHead: Hex;
    newHead: CheckpointHead;
  }): Promise<JobSnapshot> {
    return this.withJobLock(input.jobId, async () => {
      const job = await this.requireJob(input.jobId);
      this.assertTaskId(job, input.taskId);
      await this.assertAdmission(job, input.worker, input.epoch);
      if (this.authority && !this.checkpointVerifier) throw new Error("CHECKPOINT_VERIFIER_UNAVAILABLE");
      if (this.checkpointVerifier) {
        await this.checkpointVerifier.verifyCandidate({
          job,
          acceptanceSpecHash: input.acceptanceSpecHash,
          expectedHead: input.expectedHead,
          newHead: input.newHead,
        });
      }
      return this.jobs.acceptMilestone(input);
    });
  }

  public async drain(jobId: string): Promise<JobSnapshot> {
    return this.withJobLock(jobId, () => this.jobs.drain(jobId));
  }

  public async takeover(input: {
    jobId: string;
    successor: Hex;
    expectedHead: Hex;
    expectedEpoch: number;
    compatibilityReport: Hex;
  }): Promise<JobSnapshot> {
    return this.withJobLock(input.jobId, async () => {
      const job = await this.requireJob(input.jobId);
      if (!job.task.drained) throw new Error("TASK_MUST_BE_DRAINED");
      if (this.authority) {
        await this.authority.assertAssignedWorker(this.chainAdmission(job, input.successor, input.expectedEpoch + 1));
      }
      return this.jobs.takeover(input);
    });
  }

  public async resume(jobId: string): Promise<JobSnapshot> {
    return this.withJobLock(jobId, async () => {
      const job = await this.requireJob(jobId);
      if (!job.task.assignedWorker) throw new Error("WORKER_NOT_ASSIGNED");
      if (this.authority) {
        await this.authority.assertAssignedWorker(this.chainAdmission(job, job.task.assignedWorker, job.task.epoch));
      }
      return this.jobs.resume(jobId);
    });
  }

  private async reuseOrReconcile(operation: GatewayOperation, request: PaymentRequest): Promise<GatewayOperation> {
    if (operation.state === "OUTPUT_AVAILABLE") return this.recordAuthorizedReuse(operation, request);
    if (operation.state === "FAILED") throw new Error("PAYMENT_FAILED: operation is terminal");
    if (operation.state !== "SUBMITTED" && operation.state !== "UNKNOWN" && operation.state !== "SETTLED") {
      throw new Error("OPERATION_STATE_NOT_RECOVERABLE");
    }

    let reconciliation: PaymentReconciliation;
    try {
      reconciliation = await this.provider.reconcile(operation);
    } catch {
      throw new Error("PAYMENT_UNKNOWN: provider reconciliation is unavailable; reservation remains held");
    }
    if (reconciliation.status === "unknown") {
      throw new Error("PAYMENT_UNKNOWN: provider has not confirmed settlement; reservation remains held");
    }
    if (reconciliation.status === "not-settled") {
      if (operation.state === "SETTLED") {
        throw new Error("SETTLEMENT_OUTPUT_UNAVAILABLE: provider lookup contradicts the durable settlement record");
      }
      await this.ledger.transition(operation.operationId, "FAILED", { failureCode: "PROVIDER_CONFIRMED_NOT_SETTLED" });
      throw new Error("PAYMENT_FAILED: provider confirmed that no payment settled");
    }
    const result = reconciliation.result;
    let current = await this.ledger.getOperation(operation.operationId);
    if (!current) throw new Error("OPERATION_NOT_FOUND");
    if (current.state !== "SETTLED") {
      try {
        await this.ledger.transition(operation.operationId, "SETTLED", { providerReceipt: result.providerReceipt });
      } catch (error) {
        current = await this.ledger.getOperation(operation.operationId);
        if (current?.state !== "SETTLED" && current?.state !== "OUTPUT_AVAILABLE") throw error;
      }
    }
    current = await this.ledger.getOperation(operation.operationId);
    if (!current) throw new Error("OPERATION_NOT_FOUND");
    if (current.state === "OUTPUT_AVAILABLE") return this.recordAuthorizedReuse(current, request);
    if (current.state !== "SETTLED") throw new Error("PAYMENT_UNKNOWN: settlement state is not durable");
    const available = await this.ledger.transition(operation.operationId, "OUTPUT_AVAILABLE", {
      outputDigest: result.outputDigest,
      outputRef: result.outputRef,
    });
    return this.recordAuthorizedReuse(available, request);
  }

  private async recordAuthorizedReuse(operation: GatewayOperation, request: PaymentRequest): Promise<GatewayOperation> {
    if (operation.worker.toLowerCase() === request.worker.toLowerCase() && operation.epoch === request.epoch) return operation;
    return this.ledger.recordReuse(operation.operationId, request.worker, request.epoch);
  }

  private async requireJob(jobId: string): Promise<JobSnapshot> {
    const job = await this.jobs.get(jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    return job;
  }

  private assertTaskId(job: JobSnapshot, taskId: string): void {
    if (job.terms.task.taskId !== taskId) throw new Error("TASK_ID_MISMATCH");
  }

  private async assertAdmission(job: JobSnapshot, worker: Hex, epoch: number): Promise<void> {
    if (job.task.assignedWorker?.toLowerCase() !== worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
    if (job.task.epoch !== epoch) throw new Error("STALE_EPOCH");
    if (job.task.drained || job.task.status !== "FUNDED") throw new Error("GATEWAY_DRAINED");
    if (this.authority) {
      await this.authority.assertCurrentWorker(this.chainAdmission(job, worker, epoch));
    }
  }

  private requireChainJobId(job: JobSnapshot): Hex {
    if (!job.chainJobId) throw new Error("CHAIN_JOB_ID_REQUIRED");
    return job.chainJobId;
  }

  private chainAdmission(job: JobSnapshot, worker: Hex, epoch: number): ChainAdmission {
    if (!job.chainTaskId) throw new Error("CHAIN_TASK_ID_REQUIRED");
    return {
      chainJobId: this.requireChainJobId(job),
      chainTaskId: job.chainTaskId,
      termsHash: job.terms.termsHash,
      acceptedHead: job.task.acceptedHead.manifestDigest,
      acceptedSequence: job.task.acceptedHead.sequence,
      acceptedManifestRef: job.task.acceptedHead.manifestRef,
      buyer: job.terms.buyer,
      worker,
      epoch,
    };
  }

  private async withJobLock<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.jobQueues.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.jobQueues.set(jobId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.jobQueues.get(jobId) === queued) this.jobQueues.delete(jobId);
    }
  }
}

function paymentFingerprint(request: PaymentRequest): Hex {
  return digest({
    jobId: request.jobId,
    taskId: request.taskId,
    service: request.service,
    inputDigest: request.inputDigest,
    amount: request.amount.toString(),
    asset: request.asset,
  });
}
