import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import type { JobStore } from "../../domain/jobs/jobStore.js";
import { domain, TAKEOVER_TYPES, type TakeoverAck } from "../../chain/signing.js";
import type { SepoliaAuthorityReader } from "../../chain/sepoliaAuthority.js";
import type { EscrowMutationWriter } from "../../chain/sepoliaEscrowWriter.js";
import { digest, type JobSnapshot } from "../../protocol/v1.js";
import { Gateway } from "../gateway/gateway.js";
import { OperationLedger, type StoredTakeoverAcknowledgement } from "../ledger/operationLedger.js";

const emptyDigest = `0x${"0".repeat(64)}`;

export class BuyerTakeoverPolicy {
  private timer: NodeJS.Timeout | undefined;
  private active = false;

  public constructor(private readonly input: {
    jobs: JobStore;
    ledger: OperationLedger;
    gateway: Gateway;
    authority: SepoliaAuthorityReader;
    writer: Pick<EscrowMutationWriter, "drain" | "takeover">;
    workerA: Hex;
    successor: Hex;
    escrowAddress: string;
    chainId: number;
    heartbeatTimeoutMs: number;
    intervalMs: number;
  }) {
    if (input.workerA.toLowerCase() === input.successor.toLowerCase()) throw new Error("TAKEOVER_WORKERS_MUST_DIFFER");
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch((error) => {
      console.error(`[takeover-policy] cycle stopped (${safeError(error)}); task remains fenced`);
    }); }, this.input.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  public async acceptAcknowledgement(job: JobSnapshot, ack: TakeoverAck, signature: Hex): Promise<void> {
    this.validateAcknowledgement(job, ack);
    const control = await this.input.ledger.getTaskControl(job.terms.jobId, job.task.taskId);
    if (control?.state !== "DRAINED") throw new Error("TASK_NOT_DRAINED");
    if (control.worker?.toLowerCase() !== this.input.workerA.toLowerCase() || control.epoch !== job.task.epoch) {
      throw new Error("TASK_CONTROL_BINDING_MISMATCH");
    }
    if (await hasPendingOperations(this.input.ledger, job.terms.jobId)) throw new Error("UNRESOLVED_OPERATIONS");
    await this.input.authority.assertPreapprovedSuccessor(job, this.input.successor);
    await this.verifyAcknowledgementSignature(ack, signature);
    await this.input.ledger.putTakeoverAcknowledgement({
      jobId: job.terms.jobId,
      taskId: job.task.taskId,
      successor: ack.successor,
      epoch: Number(ack.epoch),
      expectedHead: ack.expectedHead,
      compatibilityReport: ack.compatibilityReport,
      servicePolicy: ack.servicePolicy,
      nonce: ack.nonce.toString(),
      expiry: Number(ack.expiry),
      signature,
      receivedAt: Date.now(),
    });
  }

  public async runOnce(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      for (const listed of await this.input.jobs.list()) {
        const job = await this.input.jobs.get(listed.terms.jobId);
        if (!job) continue;
        if (job.task.assignedWorker?.toLowerCase() !== this.input.workerA.toLowerCase()) continue;
        if (job.task.status === "PAUSED" || job.task.status === "COMPLETED" || job.task.status === "CLOSED") continue;

        const heartbeat = await this.input.ledger.getLastWorkerHeartbeat({
          jobId: job.terms.jobId,
          taskId: job.task.taskId,
          worker: this.input.workerA,
          epoch: job.task.epoch,
        });
        // A timeout is measured only after A has established liveness at this epoch.
        if (!heartbeat || Date.now() - heartbeat.observedAt < this.input.heartbeatTimeoutMs) continue;
        await this.processTimedOutJob(job);
      }
    } finally {
      this.active = false;
    }
  }

  private async processTimedOutJob(initialJob: JobSnapshot): Promise<void> {
    const existingControl = await this.input.ledger.getTaskControl(initialJob.terms.jobId, initialJob.task.taskId);
    let job = existingControl?.state === "TAKEOVER_PENDING"
      ? initialJob
      : await this.input.gateway.drain(initialJob.terms.jobId);
    let state = await this.input.authority.readTakeoverState(job, this.input.successor);
    if (state.paused || state.closed || state.expired) throw new Error("ONCHAIN_JOB_NOT_OPEN");

    const oldEpoch = job.task.epoch;
    const currentWorker = job.task.assignedWorker;
    if (!currentWorker) throw new Error("WORKER_NOT_ASSIGNED");

    if (state.assignedWorker.toLowerCase() === currentWorker.toLowerCase() && state.epoch === oldEpoch) {
      if (!state.drained) {
        await this.input.writer.drain(job);
        state = await this.input.authority.readTakeoverState(job, this.input.successor);
      }
      if (state.assignedWorker.toLowerCase() !== currentWorker.toLowerCase() || state.epoch !== oldEpoch || !state.drained) {
        throw new Error("ONCHAIN_TASK_STATE_MISMATCH");
      }
      job = await this.refreshAcceptedHeadAfterDrain(state, job, currentWorker, oldEpoch);
      this.assertHeadMatchesJob(state, job);
      await this.input.authority.assertTaskDrained(job, this.input.successor);
    } else if (state.assignedWorker.toLowerCase() !== this.input.successor.toLowerCase()
      || state.epoch !== oldEpoch + 1 || state.drained) {
      throw new Error("ONCHAIN_TAKEOVER_STATE_MISMATCH");
    } else {
      this.assertHeadMatchesJob(state, job);
    }

    await this.input.gateway.reconcilePendingOperations(job.terms.jobId);
    if (await hasPendingOperations(this.input.ledger, job.terms.jobId)) return;
    if (job.task.status === "COMPLETED") return;
    const control = await this.input.ledger.getTaskControl(job.terms.jobId, job.task.taskId);
    if (control?.state !== "DRAINED" && control?.state !== "TAKEOVER_PENDING") return;

    const stored = await this.input.ledger.getTakeoverAcknowledgement(job.terms.jobId, job.task.taskId, oldEpoch);
    if (!stored || stored.expiry <= Math.floor(Date.now() / 1000)) return;
    if (stored.expectedHead.toLowerCase() !== job.task.acceptedHead.manifestDigest.toLowerCase()) {
      await this.input.ledger.clearTakeoverAcknowledgement(job.terms.jobId, job.task.taskId, oldEpoch);
      return;
    }
    const ack = toTakeoverAck(job, stored);
    this.validateAcknowledgement(job, ack);
    await this.verifyAcknowledgementSignature(ack, stored.signature);

    state = await this.input.authority.readTakeoverState(job, this.input.successor);
    this.assertHeadMatchesJob(state, job);
    if (state.assignedWorker.toLowerCase() === currentWorker.toLowerCase() && state.epoch === oldEpoch) {
      await this.input.authority.assertPreapprovedSuccessor(job, this.input.successor);
      await this.input.writer.takeover(job, ack, stored.signature);
    } else if (state.assignedWorker.toLowerCase() !== this.input.successor.toLowerCase()
      || state.epoch !== oldEpoch + 1 || state.drained) {
      throw new Error("ONCHAIN_TAKEOVER_STATE_MISMATCH");
    }

    await this.input.authority.assertTakeoverConfirmed(job, this.input.successor, oldEpoch, ack.expectedHead);
    await this.input.gateway.takeover({
      jobId: job.terms.jobId,
      successor: this.input.successor,
      expectedHead: ack.expectedHead,
      expectedEpoch: oldEpoch,
      compatibilityReport: ack.compatibilityReport,
    });
    await this.input.ledger.clearTakeoverAcknowledgement(job.terms.jobId, job.task.taskId, oldEpoch);
  }

  private validateAcknowledgement(job: JobSnapshot, ack: TakeoverAck): void {
    if (!job.chainJobId || !job.chainTaskId) throw new Error("CHAIN_JOB_BINDING_REQUIRED");
    if (ack.jobId.toLowerCase() !== job.chainJobId.toLowerCase()) throw new Error("TAKEOVER_JOB_MISMATCH");
    if (ack.taskId.toLowerCase() !== job.chainTaskId.toLowerCase()) throw new Error("TAKEOVER_TASK_MISMATCH");
    if (ack.termsHash.toLowerCase() !== job.terms.termsHash.toLowerCase()) throw new Error("TAKEOVER_TERMS_MISMATCH");
    if (ack.successor.toLowerCase() !== this.input.successor.toLowerCase()) throw new Error("SUCCESSOR_NOT_PREAPPROVED");
    if (!job.task.assignedWorker || job.task.assignedWorker.toLowerCase() !== this.input.workerA.toLowerCase()) {
      throw new Error("WORKER_NOT_ASSIGNED");
    }
    if (ack.epoch !== BigInt(job.task.epoch)) throw new Error("STALE_EPOCH");
    if (ack.expectedHead.toLowerCase() !== job.task.acceptedHead.manifestDigest.toLowerCase()) throw new Error("STALE_HEAD");
    if (ack.servicePolicy.toLowerCase() !== digest(job.servicePolicy).toLowerCase()) throw new Error("SERVICE_POLICY_MISMATCH");
    if (ack.compatibilityReport.toLowerCase() === emptyDigest) throw new Error("COMPATIBILITY_REPORT_REQUIRED");
    const now = Math.floor(Date.now() / 1000);
    if (ack.expiry <= BigInt(now)) throw new Error("ACTION_SIGNATURE_EXPIRED");
    if (ack.expiry > BigInt(now + 300)) throw new Error("ACTION_SIGNATURE_LIFETIME_TOO_LONG");
  }

  private async refreshAcceptedHeadAfterDrain(
    state: Awaited<ReturnType<SepoliaAuthorityReader["readTakeoverState"]>>,
    job: JobSnapshot,
    worker: Hex,
    epoch: number,
  ): Promise<JobSnapshot> {
    const current = job.task.acceptedHead;
    const sameHead = state.acceptedHead.toLowerCase() === current.manifestDigest.toLowerCase()
      && state.acceptedSequence === current.sequence
      && state.acceptedManifestRef === current.manifestRef;
    if (sameHead) return job;

    if (state.assignedWorker.toLowerCase() !== worker.toLowerCase() || state.epoch !== epoch || !state.drained) {
      throw new Error("ONCHAIN_HEAD_MISMATCH");
    }
    if (state.nextMilestone !== job.task.nextMilestone + 1
      || state.acceptedSequence !== current.sequence + 1
      || state.nextMilestone > job.terms.task.milestones.length) {
      throw new Error("ONCHAIN_ACCEPTED_HEAD_REFRESH_REQUIRED");
    }
    return this.input.gateway.refreshConfirmedAcceptedCheckpoint({
      jobId: job.terms.jobId,
      producer: worker,
      producerEpoch: epoch,
      acceptedHead: state.acceptedHead,
      acceptedSequence: state.acceptedSequence,
      acceptedManifestRef: state.acceptedManifestRef,
      nextMilestone: state.nextMilestone,
      totalCredited: state.totalCredited,
    });
  }

  private async verifyAcknowledgementSignature(ack: TakeoverAck, signature: Hex): Promise<void> {
    let signer: Hex;
    try {
      signer = await recoverTypedDataAddress({
        domain: domain(this.input.chainId, getAddress(this.input.escrowAddress)),
        types: TAKEOVER_TYPES,
        primaryType: "TakeoverAck",
        message: ack,
        signature,
      });
    } catch {
      throw new Error("TAKEOVER_ACK_SIGNATURE_INVALID");
    }
    if (signer.toLowerCase() !== this.input.successor.toLowerCase()) throw new Error("TAKEOVER_ACK_SIGNER_MISMATCH");
  }

  private assertHeadMatchesJob(
    state: Awaited<ReturnType<SepoliaAuthorityReader["readTakeoverState"]>>,
    job: JobSnapshot,
  ): void {
    if (state.acceptedHead.toLowerCase() !== job.task.acceptedHead.manifestDigest.toLowerCase()
      || state.acceptedSequence !== job.task.acceptedHead.sequence
      || state.acceptedManifestRef !== job.task.acceptedHead.manifestRef) {
      throw new Error("ONCHAIN_HEAD_MISMATCH");
    }
  }
}

async function hasPendingOperations(ledger: OperationLedger, jobId: string): Promise<boolean> {
  return (await ledger.listOperations(jobId)).some((operation) => operation.state === "RESERVED"
    || operation.state === "SUBMITTED" || operation.state === "SETTLED" || operation.state === "UNKNOWN");
}

function toTakeoverAck(job: JobSnapshot, stored: StoredTakeoverAcknowledgement): TakeoverAck {
  if (!job.chainJobId || !job.chainTaskId) throw new Error("CHAIN_JOB_BINDING_REQUIRED");
  return {
    jobId: job.chainJobId,
    taskId: job.chainTaskId,
    termsHash: job.terms.termsHash,
    successor: getAddress(stored.successor),
    epoch: BigInt(stored.epoch),
    expectedHead: stored.expectedHead,
    compatibilityReport: stored.compatibilityReport,
    servicePolicy: stored.servicePolicy,
    nonce: BigInt(stored.nonce),
    expiry: BigInt(stored.expiry),
  };
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN_ERROR";
  return /^[A-Z0-9_:-]+$/.test(error.message) ? error.message : "POLICY_ERROR";
}
