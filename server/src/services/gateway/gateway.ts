import { createHash, randomUUID } from "node:crypto";
import { digest, paymentIntentFingerprint, type CheckpointHead, type GatewayOperation, type Hex, type JobSnapshot, type OperationPageCursor, type ReusableOperationPage } from "../../protocol/v1.js";
import type { ChainAdmission, JobAuthorityReader } from "../../chain/sepoliaAuthority.js";
import type { MilestoneOffer } from "../../chain/signing.js";
import { OperationLedger, type GatewayTaskControl, type GatewayTaskControlState, type LedgerBalance, type WorkerHeartbeat } from "../ledger/operationLedger.js";
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
  /** Ephemeral input for a new purchase; the SQLite ledger stores only its digest. */
  inputBytes?: Uint8Array;
};

export const MAX_PROVIDER_INPUT_BYTES = 256 * 1024;

export type ProviderPaymentRequest = PaymentRequest & Pick<GatewayOperation,
  "providerId" | "network" | "payee" | "policyVersion" | "approvedPolicyHash">;

export type PaymentResult = {
  providerReceipt: string;
  /** Actual debit after provider settlement; omitted adapters are treated as exact-amount. */
  settledAmount?: bigint;
  outputDigest: Hex;
  outputRef: string;
};

export type PaymentReconciliation =
  | { status: "settled"; result: PaymentResult }
  | { status: "not-settled" }
  | { status: "unknown" };

export interface PaymentProvider {
  submit(request: ProviderPaymentRequest): Promise<PaymentResult>;
  reconcile(operation: GatewayOperation): Promise<PaymentReconciliation>;
  retrieveOutput?(operation: GatewayOperation): Promise<Uint8Array>;
}
export interface CheckpointAcceptanceVerifier {
  verifyCandidate(input: {
    job: JobSnapshot;
    acceptanceSpecHash: Hex;
    expectedHead: Hex;
    newHead: CheckpointHead;
  }): Promise<void>;
  recoverAcceptedCheckpoint?(input: {
    job: JobSnapshot;
    producer: Hex;
    producerEpoch: number;
    acceptedHead: Hex;
    acceptedSequence: number;
    acceptedManifestRef: string;
  }): Promise<CheckpointHead>;
}

export interface EscrowLifecycleWriter {
  assignTask(job: JobSnapshot, worker: Hex): Promise<unknown>;
  acceptMilestone(job: JobSnapshot, offer: MilestoneOffer, signature: Hex): Promise<unknown>;
  pause(job: JobSnapshot): Promise<unknown>;
  resume(job: JobSnapshot): Promise<unknown>;
}

export class LocalPaymentProvider implements PaymentProvider {
  private readonly settled = new Map<string, PaymentResult>();

  public async submit(request: ProviderPaymentRequest): Promise<PaymentResult> {
    const existing = this.settled.get(request.operationId);
    if (existing) return existing;
    const result = {
      providerReceipt: `local-hedera-receipt:${request.operationId}`,
      settledAmount: request.amount,
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
    private readonly lifecycleWriter?: EscrowLifecycleWriter,
  ) {}

  public get requiresChainAuthority(): boolean {
    return this.authority !== undefined;
  }

  public get usesLocalPaymentProvider(): boolean {
    return this.provider instanceof LocalPaymentProvider;
  }

  public async assertImportableJob(job: JobSnapshot): Promise<void> {
    if (!this.authority?.assertImportableJob) throw new Error("CHAIN_JOB_IMPORT_NOT_IMPLEMENTED");
    await this.authority.assertImportableJob(job);
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
      if (request.inputBytes && createHash("sha256").update(request.inputBytes).digest("hex") !== request.inputDigest.slice(2).toLowerCase()) {
        throw new Error("INPUT_DIGEST_MISMATCH");
      }
      if (request.inputBytes && (request.inputBytes.byteLength === 0 || request.inputBytes.byteLength > MAX_PROVIDER_INPUT_BYTES)) {
        throw new Error("PROVIDER_INPUT_SIZE_LIMIT_EXCEEDED");
      }
      const job = await this.requireJob(request.jobId);
      this.assertTaskId(job, request.taskId);
      const providerRequest = withPaymentPolicy(request, job);
      const fingerprint = paymentIntentFingerprint(providerRequest);
      const existing = await this.ledger.getOperation(request.operationId);
      if (existing) {
        await this.assertReconciliationAdmission(job, existing, request.worker, request.epoch);
        const operation = await this.ledger.reserve({
          ...providerRequest,
          requestFingerprint: fingerprint,
          nonce: randomUUID(),
        });
        return this.reuseOrReconcile(operation, providerRequest);
      }

      const control = await this.assertAdmission(job, request.worker, request.epoch);
      const operation = await this.ledger.reserve({
        ...providerRequest,
        controlGeneration: control.generation,
        requestFingerprint: fingerprint,
        nonce: randomUUID(),
      });

      if (operation.state !== "RESERVED") return this.reuseOrReconcile(operation, providerRequest);

      try {
        await this.ledger.transition(operation.operationId, "SUBMITTED");
      } catch (error) {
        const current = await this.ledger.getOperation(operation.operationId);
        if (current && current.state !== "RESERVED") return this.reuseOrReconcile(current, providerRequest);
        if (current?.state === "RESERVED") {
          try {
            await this.ledger.transition(operation.operationId, "FAILED", {
              failureCode: error instanceof Error ? error.message : "SUBMISSION_STATE_PERSIST_FAILED",
            });
          } catch {
            // Keep an unresolved reservation if even its terminal transition cannot be persisted.
          }
        }
        throw error;
      }

      try {
        // Recheck confirmed authority and the durable admission generation at the spend boundary.
        const finalControl = await this.assertAdmission(job, request.worker, request.epoch);
        if (finalControl.generation !== control.generation) throw new Error("GATEWAY_GENERATION_CHANGED");
      } catch (error) {
        try {
          await this.ledger.transition(operation.operationId, "FAILED", {
            failureCode: "AUTHORITY_RECHECK_FAILED_BEFORE_PROVIDER_SUBMISSION",
          });
        } catch {
          // The provider has not been called. Keep the last durable state for safe reconciliation.
        }
        throw error;
      }

      let result: PaymentResult;
      try {
        result = await this.provider.submit(providerRequest);
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
      if (current.state === "OUTPUT_AVAILABLE") return this.recordAuthorizedReuse(current, providerRequest);
      if (current.state === "SETTLED") {
        const available = await this.ledger.transition(operation.operationId, "OUTPUT_AVAILABLE", {
          outputDigest: result.outputDigest,
          outputRef: result.outputRef,
        });
        return this.recordAuthorizedReuse(available, providerRequest);
      }
      if (current.state !== "SUBMITTED" && current.state !== "UNKNOWN") {
        throw new Error(`PAYMENT_STATE_UNEXPECTED: ${current.state}`);
      }

      try {
        await this.ledger.transition(operation.operationId, "SETTLED", {
          providerReceipt: result.providerReceipt,
          settledAmount: result.settledAmount,
        });
      } catch (error) {
        current = await this.ledger.getOperation(operation.operationId);
        if (current?.state === "OUTPUT_AVAILABLE") return this.recordAuthorizedReuse(current, providerRequest);
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
      if (current?.state === "OUTPUT_AVAILABLE") return this.recordAuthorizedReuse(current, providerRequest);
      if (current?.state !== "SETTLED") throw new Error("PAYMENT_UNKNOWN: settlement state is not durable");
      const available = await this.ledger.transition(operation.operationId, "OUTPUT_AVAILABLE", {
        outputDigest: result.outputDigest,
        outputRef: result.outputRef,
      });
      return this.recordAuthorizedReuse(available, providerRequest);
    });
  }

  public async reconcile(operationId: string, worker: Hex, epoch: number): Promise<GatewayOperation> {
    const existing = await this.ledger.getOperation(operationId);
    if (!existing) throw new Error("OPERATION_NOT_FOUND");
    return this.withJobLock(existing.jobId, async () => {
      const job = await this.requireJob(existing.jobId);
      this.assertTaskId(job, existing.taskId);
      const current = await this.ledger.getOperation(operationId);
      if (!current) throw new Error("OPERATION_NOT_FOUND");
      await this.assertReconciliationAdmission(job, current, worker, epoch);
      return this.reuseOrReconcile(current, { ...current, worker, epoch });
    });
  }

  public async heartbeat(input: {
    jobId: string;
    taskId: string;
    worker: Hex;
    epoch: number;
  }): Promise<WorkerHeartbeat> {
    const job = await this.requireJob(input.jobId);
    this.assertTaskId(job, input.taskId);
    await this.assertAdmission(job, input.worker, input.epoch);
    return this.ledger.recordWorkerHeartbeat(input);
  }

  public async listReusableOperations(input: {
    jobId: string;
    worker: Hex;
    epoch: number;
    limit: number;
    after?: OperationPageCursor;
  }): Promise<ReusableOperationPage> {
    return this.withJobLock(input.jobId, async () => {
      const job = await this.requireJob(input.jobId);
      await this.assertAdmission(job, input.worker, input.epoch);
      return this.ledger.listReusableOperations({
        jobId: input.jobId,
        taskId: job.task.taskId,
        limit: input.limit,
        after: input.after,
      });
    });
  }

  public async retrievePaidOutput(input: {
    jobId: string;
    operationId: string;
    worker: Hex;
    epoch: number;
  }): Promise<{ operationId: string; outputDigest: Hex; bytes: Uint8Array }> {
    const existing = await this.ledger.getOperation(input.operationId);
    if (!existing || existing.jobId !== input.jobId) throw new Error("OPERATION_NOT_FOUND");
    return this.withJobLock(input.jobId, async () => {
      const job = await this.requireJob(input.jobId);
      this.assertTaskId(job, existing.taskId);
      const operation = await this.ledger.getOperation(input.operationId);
      if (!operation || operation.jobId !== input.jobId) throw new Error("OPERATION_NOT_FOUND");
      await this.assertReconciliationAdmission(job, operation, input.worker, input.epoch);
      if (operation.state !== "OUTPUT_AVAILABLE" || !operation.outputRef || !operation.outputDigest) {
        throw new Error("PAID_OUTPUT_NOT_AVAILABLE");
      }
      if (!this.provider.retrieveOutput) throw new Error("PAID_OUTPUT_RETRIEVAL_UNAVAILABLE");
      const bytes = await this.provider.retrieveOutput(operation);
      const outputDigest = `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
      if (outputDigest.toLowerCase() !== operation.outputDigest.toLowerCase()) {
        throw new Error("PAID_OUTPUT_DIGEST_MISMATCH");
      }
      return { operationId: operation.operationId, outputDigest, bytes };
    });
  }

  /** Reconcile every pending provider operation after the durable drain barrier is set. */
  public async reconcilePendingOperations(jobId: string): Promise<boolean> {
    const operations = await this.ledger.listOperations(jobId);
    for (const operation of operations) {
      if (operation.state !== "RESERVED" && operation.state !== "SUBMITTED"
        && operation.state !== "SETTLED" && operation.state !== "UNKNOWN") continue;
      try {
        await this.reconcile(operation.operationId, operation.worker, operation.epoch);
      } catch {
        // An unresolved provider result remains reserved and blocks takeover on the next pass.
      }
    }
    const remaining = await this.ledger.listOperations(jobId);
    return !remaining.some((operation) => operation.state === "RESERVED"
      || operation.state === "SUBMITTED" || operation.state === "SETTLED" || operation.state === "UNKNOWN");
  }

  public async assign(jobId: string, worker: Hex): Promise<JobSnapshot> {
    return this.withJobLock(jobId, async () => {
      const job = await this.requireJob(jobId);
      if (this.authority) {
        if (!this.lifecycleWriter || !this.authority.assertAssignmentTransition || !this.authority.assertAssignmentConfirmed) {
          throw new Error("ESCROW_LIFECYCLE_WRITER_UNAVAILABLE");
        }
        const alreadyAssigned = await this.authority.assertAssignmentTransition(job, worker);
        if (!alreadyAssigned) await this.lifecycleWriter.assignTask(job, worker);
        await this.authority.assertAssignmentConfirmed(job, worker);
      }
      const assigned = await this.jobs.assign(jobId, worker, this.authority !== undefined);
      await this.ledger.ensureTaskControl({
        jobId,
        taskId: assigned.task.taskId,
        worker,
        epoch: assigned.task.epoch,
        state: "RUNNING",
      });
      return assigned;
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
    offer?: MilestoneOffer;
    offerSignature?: Hex;
  }): Promise<JobSnapshot> {
    return this.withJobLock(input.jobId, async () => {
      const job = await this.requireJob(input.jobId);
      this.assertTaskId(job, input.taskId);
      let alreadyAccepted = false;
      if (this.authority) {
        if (!this.lifecycleWriter || !this.authority.assertMilestoneTransition || !this.authority.assertMilestoneAccepted
          || !input.offer || !input.offerSignature) throw new Error("ESCROW_LIFECYCLE_WRITER_UNAVAILABLE");
        if (input.offer.jobId.toLowerCase() !== job.chainJobId?.toLowerCase()
          || input.offer.taskId.toLowerCase() !== job.chainTaskId?.toLowerCase()
          || input.offer.termsHash.toLowerCase() !== job.terms.termsHash.toLowerCase()
          || input.offer.producer.toLowerCase() !== input.worker.toLowerCase()
          || input.offer.epoch !== BigInt(input.epoch)
          || input.offer.milestone !== job.task.nextMilestone
          || input.offer.acceptanceSpecHash.toLowerCase() !== input.acceptanceSpecHash.toLowerCase()
          || input.offer.expectedHead.toLowerCase() !== input.expectedHead.toLowerCase()
          || input.offer.newHead.toLowerCase() !== input.newHead.manifestDigest.toLowerCase()
          || input.offer.manifestRef !== input.newHead.manifestRef
          || input.offer.sequence !== BigInt(input.newHead.sequence)) throw new Error("MILESTONE_OFFER_MISMATCH");
        alreadyAccepted = await this.authority.assertMilestoneTransition(job, input);
        if (!alreadyAccepted) await this.assertAdmission(job, input.worker, input.epoch);
      } else {
        await this.assertAdmission(job, input.worker, input.epoch);
      }
      if (this.authority && !this.checkpointVerifier) throw new Error("CHECKPOINT_VERIFIER_UNAVAILABLE");
      if (this.checkpointVerifier) {
        await this.checkpointVerifier.verifyCandidate({
          job,
          acceptanceSpecHash: input.acceptanceSpecHash,
          expectedHead: input.expectedHead,
          newHead: input.newHead,
        });
      }
      if (this.authority) {
        if (!alreadyAccepted) await this.lifecycleWriter!.acceptMilestone(job, input.offer!, input.offerSignature!);
        const milestone = job.terms.task.milestones[job.task.nextMilestone];
        if (!milestone) throw new Error("NO_MILESTONE_REMAINING");
        await this.authority!.assertMilestoneAccepted!(job, {
          worker: input.worker,
          epoch: input.epoch,
          newHead: input.newHead,
          nextMilestone: job.task.nextMilestone + 1,
          totalCredited: job.credits.reduce((total, credit) => total + credit.amount, 0n) + milestone.reward,
        });
      }
      return this.jobs.acceptMilestone({ ...input, confirmedOnChain: this.authority !== undefined });
    });
  }

  /** Refresh a drained local snapshot only after recovering the exact checkpoint committed on-chain. */
  public async refreshConfirmedAcceptedCheckpoint(input: {
    jobId: string;
    producer: Hex;
    producerEpoch: number;
    acceptedHead: Hex;
    acceptedSequence: number;
    acceptedManifestRef: string;
    nextMilestone: number;
    totalCredited: bigint;
  }): Promise<JobSnapshot> {
    return this.withJobLock(input.jobId, async () => {
      const job = await this.requireJob(input.jobId);
      if (!job.task.drained || job.task.status !== "DRAINED") throw new Error("TASK_NOT_DRAINED");
      if (job.task.assignedWorker?.toLowerCase() !== input.producer.toLowerCase()
        || job.task.epoch !== input.producerEpoch) throw new Error("ONCHAIN_ASSIGNMENT_CHANGED");
      if (!this.checkpointVerifier?.recoverAcceptedCheckpoint) {
        throw new Error("ACCEPTED_CHECKPOINT_RECOVERY_UNAVAILABLE");
      }
      const newHead = await this.checkpointVerifier.recoverAcceptedCheckpoint({
        job,
        producer: input.producer,
        producerEpoch: input.producerEpoch,
        acceptedHead: input.acceptedHead,
        acceptedSequence: input.acceptedSequence,
        acceptedManifestRef: input.acceptedManifestRef,
      });
      return this.jobs.reconcileConfirmedMilestone({
        jobId: input.jobId,
        producer: input.producer,
        producerEpoch: input.producerEpoch,
        newHead,
        nextMilestone: input.nextMilestone,
        totalCredited: input.totalCredited,
      });
    });
  }

  public async drain(jobId: string): Promise<JobSnapshot> {
    const job = await this.requireJob(jobId);
    if (job.task.status === "CLOSED") throw new Error("TASK_CLOSED");
    if (job.task.status === "COMPLETED") throw new Error("TASK_NOT_OPEN");
    if (!job.task.assignedWorker) throw new Error("WORKER_NOT_ASSIGNED");
    const control = await this.ensureTaskControl(job);
    await this.ledger.beginDrain({
      jobId,
      taskId: job.task.taskId,
      worker: job.task.assignedWorker,
      epoch: job.task.epoch,
      generation: control.generation,
    });
    // The SQLite admission barrier is set before waiting for active provider work to leave
    // its per-job critical section. This stops new spend immediately and lets the drain
    // caller reconcile only after an in-flight submit has returned a definitive outcome.
    return this.withJobLock(jobId, async () => {
      await this.jobs.drain(jobId);
      return this.requireJob(jobId);
    });
  }

  public async takeover(input: {
    jobId: string;
    successor: Hex;
    expectedHead: Hex;
    expectedEpoch: number;
    compatibilityReport: Hex;
  }): Promise<JobSnapshot> {
    return this.withJobLock(input.jobId, async () => {
      let job = await this.requireJob(input.jobId);
      if (job.task.status === "PAUSED" || job.task.status === "COMPLETED" || job.task.status === "CLOSED") {
        throw new Error("TASK_NOT_OPEN");
      }
      if (job.task.acceptedHead.manifestDigest !== input.expectedHead) throw new Error("STALE_HEAD");
      if (job.task.epoch !== input.expectedEpoch && job.task.epoch !== input.expectedEpoch + 1) throw new Error("STALE_EPOCH");

      const initialState: GatewayTaskControlState = job.task.drained ? "DRAINED" : "RUNNING";
      let control = await this.ledger.ensureTaskControl({
        jobId: job.terms.jobId,
        taskId: job.task.taskId,
        worker: job.task.assignedWorker,
        epoch: job.task.epoch,
        state: initialState,
      });
      if (job.task.drained && (control.state === "RUNNING" || control.state === "PAUSED")) {
        if (!control.worker) throw new Error("WORKER_NOT_ASSIGNED");
        control = await this.ledger.beginDrain({
          jobId: job.terms.jobId,
          taskId: job.task.taskId,
          worker: control.worker,
          epoch: control.epoch,
          generation: control.generation,
        });
      }
      if (!job.task.drained && (control.state === "DRAINING" || control.state === "DRAINED")) {
        await this.jobs.drain(input.jobId);
        job = await this.requireJob(input.jobId);
      }
      if (!job.task.drained && !(job.task.assignedWorker?.toLowerCase() === input.successor.toLowerCase()
        && job.task.epoch === input.expectedEpoch + 1)) throw new Error("TASK_MUST_BE_DRAINED");
      const successorEpoch = input.expectedEpoch + 1;
      const alreadyConfirmed = control.state === "RUNNING"
        && control.worker?.toLowerCase() === input.successor.toLowerCase()
        && control.epoch === successorEpoch;

      if (!alreadyConfirmed) {
        if (!control.worker) throw new Error("WORKER_NOT_ASSIGNED");
        control = await this.ledger.beginTakeover({
          jobId: job.terms.jobId,
          taskId: job.task.taskId,
          worker: control.worker,
          epoch: control.epoch,
          successor: input.successor,
          successorEpoch,
          generation: control.generation,
        });
      }

      if (this.authority) {
        await this.authority.assertAssignedWorker(this.chainAdmission(job, input.successor, successorEpoch));
      }

      if (job.task.assignedWorker?.toLowerCase() !== input.successor.toLowerCase()) {
        await this.jobs.takeover(input);
      }
      if (!alreadyConfirmed) {
        const pending = await this.ledger.getTaskControl(job.terms.jobId, job.task.taskId);
        if (!pending) throw new Error("TASK_CONTROL_NOT_INITIALIZED");
        control = await this.ledger.confirmTakeover({
          jobId: job.terms.jobId,
          taskId: job.task.taskId,
          successor: input.successor,
          successorEpoch,
          generation: pending.generation,
        });
      }
      if (control.state !== "RUNNING") throw new Error("TAKEOVER_STATE_CHANGED");
      return this.jobs.reopen(input.jobId, {
        state: "RUNNING",
        worker: input.successor,
        epoch: successorEpoch,
        generation: control.generation,
      });
    });
  }

  public async cancelDrain(jobId: string, confirmOnChain?: (job: JobSnapshot) => Promise<void>): Promise<JobSnapshot> {
    if (this.authority && !confirmOnChain) throw new Error("CHAIN_DRAIN_CANCELLATION_REQUIRED");
    const initialJob = await this.requireJob(jobId);
    if (initialJob.task.status === "PAUSED") throw new Error("TASK_PAUSED");
    if (initialJob.task.status === "COMPLETED" || initialJob.task.status === "CLOSED") throw new Error("TASK_NOT_OPEN");
    if (!initialJob.task.assignedWorker) throw new Error("WORKER_NOT_ASSIGNED");
    const initialControl = await this.ensureTaskControl(initialJob);
    if (!["DRAINING", "DRAINED", "TAKEOVER_PENDING"].includes(initialControl.state)) {
      throw new Error("TASK_NOT_DRAINED");
    }
    if (!await this.reconcilePendingOperations(jobId)) throw new Error("UNRESOLVED_OPERATIONS");

    return this.withJobLock(jobId, async () => {
      let job = await this.requireJob(jobId);
      if (job.task.status === "PAUSED") throw new Error("TASK_PAUSED");
      if (job.task.status === "COMPLETED" || job.task.status === "CLOSED") throw new Error("TASK_NOT_OPEN");
      if (!job.task.assignedWorker) throw new Error("WORKER_NOT_ASSIGNED");
      const worker = job.task.assignedWorker;

      let control = await this.ensureTaskControl(job);
      if (control.state === "TAKEOVER_PENDING") {
        control = await this.ledger.cancelTakeover({
          jobId,
          taskId: job.task.taskId,
          worker,
          epoch: job.task.epoch,
          generation: control.generation,
        });
      }
      if (control.state === "DRAINING") {
        control = (await this.ledger.getTaskControl(jobId, job.task.taskId)) ?? control;
      }
      if (control.state !== "DRAINED") throw new Error("TASK_NOT_DRAINED");
      if ((await this.ledger.listOperations(jobId)).some((operation) =>
        operation.state === "RESERVED" || operation.state === "SUBMITTED"
        || operation.state === "SETTLED" || operation.state === "UNKNOWN")) {
        throw new Error("UNRESOLVED_OPERATIONS");
      }

      if (!job.task.drained) {
        await this.jobs.drain(jobId);
        job = await this.requireJob(jobId);
      }
      await confirmOnChain?.(job);

      control = await this.ledger.resumeTask({
        jobId,
        taskId: job.task.taskId,
        worker,
        epoch: job.task.epoch,
        generation: control.generation,
        from: "DRAINED",
      });
      if (control.state !== "RUNNING") throw new Error("GATEWAY_REOPEN_PROOF_INVALID");
      await this.ledger.clearTakeoverAcknowledgement(jobId, job.task.taskId, job.task.epoch);
      return this.jobs.reopen(jobId, {
        state: "RUNNING",
        worker,
        epoch: job.task.epoch,
        generation: control.generation,
      });
    });
  }

  public async resume(jobId: string): Promise<JobSnapshot> {
    return this.withJobLock(jobId, async () => {
      let job = await this.requireJob(jobId);
      if (!job.task.assignedWorker) throw new Error("WORKER_NOT_ASSIGNED");
      const worker = job.task.assignedWorker;
      const epoch = job.task.epoch;
      const control = await this.ensureTaskControl(job);

      if (control.state === "TAKEOVER_PENDING") throw new Error("TAKEOVER_PENDING");
      if (control.state === "DRAINED" || control.state === "DRAINING" || job.task.drained) {
        throw new Error("CANCEL_DRAIN_REQUIRED");
      }

      if (this.authority) {
        await this.authority.assertAssignedWorker(this.chainAdmission(job, worker, epoch));
      }

      if (control.state === "PAUSED") {
        if (job.task.status === "PAUSED") await this.jobs.resume(jobId);
        await this.ledger.resumeTask({
          jobId,
          taskId: job.task.taskId,
          worker,
          epoch,
          generation: control.generation,
          from: "PAUSED",
        });
        return this.requireJob(jobId);
      }
      if (control.state === "RUNNING") {
        if (job.task.status === "PAUSED") return this.jobs.resume(jobId);
        return job;
      }
      throw new Error("GATEWAY_DRAINED");
    });
  }

  public async pause(jobId: string, confirmOnChain?: (job: JobSnapshot) => Promise<void>): Promise<JobSnapshot> {
    return this.withJobLock(jobId, async () => {
      const job = await this.requireJob(jobId);
      if (!job.task.assignedWorker) throw new Error("WORKER_NOT_ASSIGNED");
      if (job.task.status === "COMPLETED" || job.task.status === "CLOSED") throw new Error("TASK_NOT_OPEN");
      const control = await this.ensureTaskControl(job);
      if (control.state === "RUNNING") {
        await this.ledger.pauseTask({
          jobId,
          taskId: job.task.taskId,
          worker: job.task.assignedWorker,
          epoch: job.task.epoch,
          generation: control.generation,
        });
      } else if (control.state !== "PAUSED") {
        throw new Error("TASK_NOT_RUNNING");
      }
      await confirmOnChain?.(job);
      return this.jobs.pause(jobId);
    });
  }

  private async reuseOrReconcile(operation: GatewayOperation, request: ProviderPaymentRequest): Promise<GatewayOperation> {
    if (operation.state === "OUTPUT_AVAILABLE") return this.recordAuthorizedReuse(operation, request);
    if (operation.state === "FAILED") throw new Error("PAYMENT_FAILED: operation is terminal");
    if (operation.state === "RESERVED") {
      await this.ledger.transition(operation.operationId, "FAILED", { failureCode: "NOT_SUBMITTED_BEFORE_DRAIN" });
      throw new Error("PAYMENT_FAILED: operation was never submitted to the provider");
    }
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
        await this.ledger.transition(operation.operationId, "SETTLED", {
          providerReceipt: result.providerReceipt,
          settledAmount: result.settledAmount,
        });
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

  private async recordAuthorizedReuse(operation: GatewayOperation, request: ProviderPaymentRequest): Promise<GatewayOperation> {
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

  private async assertAdmission(job: JobSnapshot, worker: Hex, epoch: number): Promise<GatewayTaskControl> {
    if (job.task.assignedWorker?.toLowerCase() !== worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
    if (job.task.epoch !== epoch) throw new Error("STALE_EPOCH");
    const control = await this.ensureTaskControl(job);
    const admitted = await this.ledger.assertTaskAdmission({
      jobId: job.terms.jobId,
      taskId: job.task.taskId,
      worker,
      epoch,
      generation: control.generation,
    });
    if (job.task.drained || job.task.status !== "FUNDED") throw new Error("GATEWAY_DRAINED");
    if (this.authority) {
      await this.authority.assertCurrentWorker(this.chainAdmission(job, worker, epoch));
    }
    return admitted;
  }

  private async assertReconciliationAdmission(
    job: JobSnapshot,
    operation: GatewayOperation,
    worker: Hex,
    epoch: number,
  ): Promise<void> {
    if (job.task.assignedWorker?.toLowerCase() !== worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
    if (job.task.epoch !== epoch) throw new Error("STALE_EPOCH");
    await this.ensureTaskControl(job);
    await this.ledger.assertTaskReconciliation({
      jobId: job.terms.jobId,
      taskId: job.task.taskId,
      worker,
      epoch,
    });
    if ((operation.state === "RESERVED" || operation.state === "SUBMITTED"
      || operation.state === "SETTLED" || operation.state === "UNKNOWN")
      && (operation.worker.toLowerCase() !== worker.toLowerCase() || operation.epoch !== epoch)) {
      throw new Error("OPERATION_OWNER_MISMATCH");
    }
    if (this.authority) {
      if (!this.authority.assertReconciliationWorker) throw new Error("CHAIN_RECONCILIATION_CHECK_UNAVAILABLE");
      await this.authority.assertReconciliationWorker(this.chainAdmission(job, worker, epoch));
    }
  }

  private async ensureTaskControl(job: JobSnapshot): Promise<GatewayTaskControl> {
    const initialState: GatewayTaskControlState = job.task.drained
      ? "DRAINED"
      : job.task.status === "PAUSED" ? "PAUSED" : "RUNNING";
    return this.ledger.ensureTaskControl({
      jobId: job.terms.jobId,
      taskId: job.task.taskId,
      worker: job.task.assignedWorker,
      epoch: job.task.epoch,
      state: initialState,
    });
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

function withPaymentPolicy(request: PaymentRequest, job: JobSnapshot): ProviderPaymentRequest {
  const policy = job.servicePolicy;
  return {
    ...request,
    providerId: policy.providerId,
    network: policy.network,
    payee: policy.payee,
    policyVersion: policy.policyVersion,
    approvedPolicyHash: digest(policy),
  };
}
