import { randomUUID } from "node:crypto";
import { digest, paymentIntentFingerprint, type CheckpointHead, type GatewayOperation, type Hex, type JobSnapshot } from "../../protocol/v1.js";
import type { ChainAdmission, JobAuthorityReader } from "../../chain/sepoliaAuthority.js";
import { OperationLedger, type LedgerBalance } from "../ledger/operationLedger.js";
import { JobStore } from "../../domain/jobs/jobStore.js";
import { getAddress, recoverTypedDataAddress } from "viem";
import { OFFER_TYPES, TAKEOVER_TYPES, type MilestoneOffer, type TakeoverAck, domain } from "../../chain/signing.js";
import type { EscrowMutationWriter } from "../../chain/sepoliaEscrowWriter.js";

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

export type ProviderPaymentRequest = PaymentRequest & Pick<GatewayOperation,
  "providerId" | "network" | "payee" | "policyVersion" | "approvedPolicyHash">;

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
  submit(request: ProviderPaymentRequest): Promise<PaymentResult>;
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

export type MilestoneOfferAuthorization = {
  nonce: bigint;
  expiry: bigint;
  signature: Hex;
};

export type TakeoverAuthorization = {
  nonce: bigint;
  expiry: bigint;
  signature: Hex;
};

export class LocalPaymentProvider implements PaymentProvider {
  private readonly settled = new Map<string, PaymentResult>();

  public async submit(request: ProviderPaymentRequest): Promise<PaymentResult> {
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
    private readonly mutationWriter?: EscrowMutationWriter,
    private readonly chainId = 11155111,
    private readonly escrowAddress?: Hex,
  ) {}

  public get requiresChainAuthority(): boolean {
    return this.authority !== undefined;
  }

  public get supportsChainMutations(): boolean {
    return this.authority !== undefined && this.mutationWriter !== undefined
      && this.authority.assertSnapshotCurrent !== undefined && this.escrowAddress !== undefined;
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
      const job = await this.requireJob(request.jobId);
      this.assertTaskId(job, request.taskId);
      await this.assertAdmission(job, request.worker, request.epoch);
      const providerRequest = withPaymentPolicy(request, job);
      const fingerprint = paymentIntentFingerprint(providerRequest);
      const operation = await this.ledger.reserve({
        ...providerRequest,
        requestFingerprint: fingerprint,
        nonce: randomUUID(),
      });

      if (operation.state !== "RESERVED") return this.reuseOrReconcile(operation, providerRequest);

      try {
        await this.ledger.transition(operation.operationId, "SUBMITTED");
      } catch (error) {
        const current = await this.ledger.getOperation(operation.operationId);
        if (current && current.state !== "RESERVED") return this.reuseOrReconcile(current, providerRequest);
        throw error;
      }

      try {
        // The initial check can be separated from provider I/O by ledger writes. Recheck the
        // confirmed worker/epoch/drain state at the spend boundary before releasing payment.
        await this.assertAdmission(job, request.worker, request.epoch);
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
        await this.ledger.transition(operation.operationId, "SETTLED", { providerReceipt: result.providerReceipt });
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
      await this.assertAdmission(job, worker, epoch);
      const current = await this.ledger.getOperation(operationId);
      if (!current) throw new Error("OPERATION_NOT_FOUND");
      return this.reuseOrReconcile(current, { ...current, worker, epoch });
    });
  }

  public async assign(jobId: string, worker: Hex): Promise<JobSnapshot> {
    return this.withJobLock(jobId, async () => {
      const job = await this.requireJob(jobId);
      if (job.task.status !== "FUNDED" || job.task.assignedWorker) throw new Error("TASK_NOT_ASSIGNABLE");
      if (Math.floor(Date.now() / 1000) >= job.terms.cutoff) throw new Error("JOB_DEADLINE_PASSED");
      if (this.authority) {
        const writer = this.requireMutationWriter();
        await this.assertSnapshotCurrent(job);
        const expected = structuredClone(job);
        expected.task.assignedWorker = worker;
        expected.task.epoch = 1;
        await writer.assign(job, worker);
        await this.assertSnapshotCurrent(expected);
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
    offerAuthorization?: MilestoneOfferAuthorization;
  }): Promise<JobSnapshot> {
    return this.withJobLock(input.jobId, async () => {
      const job = await this.requireJob(input.jobId);
      this.assertTaskId(job, input.taskId);
      await this.assertAdmission(job, input.worker, input.epoch);
      if (Math.floor(Date.now() / 1000) >= Math.min(job.terms.cutoff, job.terms.task.deadline)) {
        throw new Error("JOB_DEADLINE_PASSED");
      }
      if (job.task.acceptedHead.manifestDigest !== input.expectedHead) throw new Error("STALE_HEAD");
      const currentMilestone = job.terms.task.milestones[job.task.nextMilestone];
      if (!currentMilestone) throw new Error("NO_MILESTONE_REMAINING");
      if (currentMilestone.acceptanceSpecHash !== input.acceptanceSpecHash) throw new Error("ACCEPTANCE_SPEC_MISMATCH");
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
        const writer = this.requireMutationWriter();
        const offer = this.makeMilestoneOffer(job, input, input.offerAuthorization);
        await this.assertOfferSignature(offer, input.offerAuthorization!.signature, input.worker);
        await this.assertSnapshotCurrent(job);
        const expected = projectAcceptedMilestone(job, input);
        await writer.acceptMilestone(job, offer, input.offerAuthorization!.signature);
        await this.assertSnapshotCurrent(expected);
      }
      return this.jobs.acceptMilestone(input);
    });
  }

  public async drain(jobId: string): Promise<JobSnapshot> {
    return this.withJobLock(jobId, async () => {
      const job = await this.requireJob(jobId);
      if (job.task.status === "CLOSED" || job.task.status === "COMPLETED") throw new Error("TASK_NOT_OPEN");
      if (this.authority) {
        const writer = this.requireMutationWriter();
        await this.assertSnapshotCurrent(job);
        const expected = structuredClone(job);
        expected.task.drained = true;
        expected.task.status = expected.task.status === "PAUSED" ? "PAUSED" : "DRAINED";
        await writer.drain(job);
        await this.assertSnapshotCurrent(expected);
      }
      return this.jobs.drain(jobId);
    });
  }

  public async takeover(input: {
    jobId: string;
    successor: Hex;
    expectedHead: Hex;
    expectedEpoch: number;
    compatibilityReport: Hex;
    authorization?: TakeoverAuthorization;
  }): Promise<JobSnapshot> {
    return this.withJobLock(input.jobId, async () => {
      const job = await this.requireJob(input.jobId);
      if (!job.task.drained) throw new Error("TASK_MUST_BE_DRAINED");
      if (job.task.status === "PAUSED" || job.task.status === "COMPLETED" || job.task.status === "CLOSED") {
        throw new Error("TASK_NOT_OPEN");
      }
      if (job.task.acceptedHead.manifestDigest !== input.expectedHead) throw new Error("STALE_HEAD");
      if (job.task.epoch !== input.expectedEpoch) throw new Error("STALE_EPOCH");
      if (job.task.assignedWorker?.toLowerCase() === input.successor.toLowerCase()) throw new Error("SUCCESSOR_ALREADY_ACTIVE");
      if (input.compatibilityReport === "0x" + "00".repeat(32)) throw new Error("COMPATIBILITY_REPORT_REQUIRED");
      if (this.authority) {
        const writer = this.requireMutationWriter();
        const ack = this.makeTakeoverAck(job, input, input.authorization);
        await this.assertTakeoverSignature(ack, input.authorization!.signature, input.successor);
        await this.assertSnapshotCurrent(job);
        const expected = structuredClone(job);
        expected.task.assignedWorker = input.successor;
        expected.task.epoch += 1;
        expected.task.drained = false;
        if (expected.task.status === "DRAINED") expected.task.status = "FUNDED";
        await writer.takeover(job, ack, input.authorization!.signature);
        await this.assertSnapshotCurrent(expected);
      }
      return this.jobs.takeover(input);
    });
  }

  public async pause(jobId: string): Promise<JobSnapshot> {
    return this.withJobLock(jobId, async () => {
      const job = await this.requireJob(jobId);
      if (job.task.status === "CLOSED") throw new Error("TASK_CLOSED");
      if (this.authority) {
        const writer = this.requireMutationWriter();
        await this.assertSnapshotCurrent(job);
        const expected = structuredClone(job);
        expected.task.status = "PAUSED";
        await writer.pause(job);
        await this.assertSnapshotCurrent(expected);
      }
      return this.jobs.pause(jobId);
    });
  }

  public async resume(jobId: string): Promise<JobSnapshot> {
    return this.withJobLock(jobId, async () => {
      const job = await this.requireJob(jobId);
      if (!job.task.assignedWorker) throw new Error("WORKER_NOT_ASSIGNED");
      if (job.task.status !== "PAUSED") throw new Error("TASK_NOT_PAUSED");
      if (this.authority) {
        const writer = this.requireMutationWriter();
        await this.assertSnapshotCurrent(job);
        const expected = structuredClone(job);
        expected.task.status = "FUNDED";
        await writer.resume(job);
        await this.assertSnapshotCurrent(expected);
      }
      return this.jobs.resume(jobId);
    });
  }

  public async claim(jobId: string, worker: Hex, signedTransaction?: Hex): Promise<{ amount: bigint; credits: JobSnapshot["credits"] }> {
    return this.withJobLock(jobId, async () => {
      const job = await this.requireJob(jobId);
      if (this.authority) {
        const writer = this.requireMutationWriter();
        if (!signedTransaction) throw new Error("WORKER_CLAIM_TRANSACTION_REQUIRED");
        await this.assertSnapshotCurrent(job);
        const expected = structuredClone(job);
        const credits = expected.credits.filter((credit) => credit.worker.toLowerCase() === worker.toLowerCase() && !credit.claimed);
        if (credits.length === 0) throw new Error("NO_WITHDRAWABLE_CREDITS");
        for (const credit of credits) credit.claimed = true;
        await writer.claim(job, worker, signedTransaction);
        await this.assertSnapshotCurrent(expected);
      }
      return this.jobs.claim(jobId, worker);
    });
  }

  private async reuseOrReconcile(operation: GatewayOperation, request: ProviderPaymentRequest): Promise<GatewayOperation> {
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

  private requireMutationWriter(): EscrowMutationWriter {
    if (!this.supportsChainMutations) throw new Error("CHAIN_MUTATION_WRITER_UNAVAILABLE");
    return this.mutationWriter!;
  }

  private async assertSnapshotCurrent(job: JobSnapshot): Promise<void> {
    if (!this.authority?.assertSnapshotCurrent) throw new Error("CHAIN_MUTATION_CONFIRMATION_UNAVAILABLE");
    await this.authority.assertSnapshotCurrent(job);
  }

  private async assertOfferSignature(offer: MilestoneOffer, signature: Hex, signer: Hex): Promise<void> {
    if (!this.escrowAddress) throw new Error("CHAIN_MUTATION_CONFIRMATION_UNAVAILABLE");
    let recovered: string;
    try {
      recovered = await recoverTypedDataAddress({
        domain: domain(this.chainId, getAddress(this.escrowAddress)),
        types: OFFER_TYPES,
        primaryType: "MilestoneOffer",
        message: offer,
        signature,
      });
    } catch {
      throw new Error("CHAIN_WORKER_SIGNATURE_INVALID");
    }
    if (getAddress(recovered) !== getAddress(signer)) throw new Error("CHAIN_WORKER_SIGNATURE_INVALID");
  }

  private async assertTakeoverSignature(ack: TakeoverAck, signature: Hex, signer: Hex): Promise<void> {
    if (!this.escrowAddress) throw new Error("CHAIN_MUTATION_CONFIRMATION_UNAVAILABLE");
    let recovered: string;
    try {
      recovered = await recoverTypedDataAddress({
        domain: domain(this.chainId, getAddress(this.escrowAddress)),
        types: TAKEOVER_TYPES,
        primaryType: "TakeoverAck",
        message: ack,
        signature,
      });
    } catch {
      throw new Error("CHAIN_WORKER_SIGNATURE_INVALID");
    }
    if (getAddress(recovered) !== getAddress(signer)) throw new Error("CHAIN_WORKER_SIGNATURE_INVALID");
  }

  private makeMilestoneOffer(
    job: JobSnapshot,
    input: { worker: Hex; epoch: number; acceptanceSpecHash: Hex; expectedHead: Hex; newHead: CheckpointHead },
    authorization?: MilestoneOfferAuthorization,
  ): MilestoneOffer {
    if (!authorization || !this.escrowAddress || !job.chainJobId || !job.chainTaskId) {
      throw new Error("WORKER_MILESTONE_SIGNATURE_REQUIRED");
    }
    assertSignatureWindow(authorization.nonce, authorization.expiry);
    const offer: MilestoneOffer = {
      jobId: job.chainJobId,
      taskId: job.chainTaskId,
      termsHash: job.terms.termsHash,
      producer: getAddress(input.worker),
      epoch: BigInt(input.epoch),
      milestone: job.task.nextMilestone,
      acceptanceSpecHash: input.acceptanceSpecHash,
      expectedHead: input.expectedHead,
      newHead: input.newHead.manifestDigest,
      manifestRef: input.newHead.manifestRef,
      sequence: BigInt(input.newHead.sequence),
      nonce: authorization.nonce,
      expiry: authorization.expiry,
    };
    return offer;
  }

  private makeTakeoverAck(
    job: JobSnapshot,
    input: { successor: Hex; expectedHead: Hex; expectedEpoch: number; compatibilityReport: Hex },
    authorization?: TakeoverAuthorization,
  ): TakeoverAck {
    if (!authorization || !this.escrowAddress || !job.chainJobId || !job.chainTaskId) {
      throw new Error("SUCCESSOR_TAKEOVER_SIGNATURE_REQUIRED");
    }
    assertSignatureWindow(authorization.nonce, authorization.expiry);
    return {
      jobId: job.chainJobId,
      taskId: job.chainTaskId,
      termsHash: job.terms.termsHash,
      successor: getAddress(input.successor),
      epoch: BigInt(input.expectedEpoch),
      expectedHead: input.expectedHead,
      compatibilityReport: input.compatibilityReport,
      servicePolicy: digest(job.servicePolicy),
      nonce: authorization.nonce,
      expiry: authorization.expiry,
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

function projectAcceptedMilestone(
  job: JobSnapshot,
  input: { worker: Hex; newHead: CheckpointHead },
): JobSnapshot {
  const expected = structuredClone(job);
  const milestone = expected.terms.task.milestones[expected.task.nextMilestone];
  if (!milestone) throw new Error("NO_MILESTONE_REMAINING");
  expected.task.acceptedHead = input.newHead;
  expected.task.nextMilestone += 1;
  expected.credits.push({
    id: `chain-preview-${expected.task.nextMilestone}`,
    worker: input.worker,
    milestoneId: milestone.id,
    amount: milestone.reward,
    claimed: false,
  });
  if (expected.task.nextMilestone === expected.terms.task.milestones.length) expected.task.status = "COMPLETED";
  return expected;
}

function assertSignatureWindow(nonce: bigint, expiry: bigint): void {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (nonce < 0n) throw new Error("CHAIN_SIGNATURE_NONCE_INVALID");
  if (expiry <= now) throw new Error("CHAIN_SIGNATURE_EXPIRED");
  if (expiry > now + 300n) throw new Error("CHAIN_SIGNATURE_LIFETIME_TOO_LONG");
}
