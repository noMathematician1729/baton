import { CHECKPOINT_RETENTION_MARGIN_DAYS } from "../../../packages/storage/src/retention.js";
import type { JobStore } from "../../domain/jobs/jobStore.js";
import type { JobSnapshot } from "../../protocol/v1.js";

type ConfirmedSnapshotReader = {
  assertSnapshotCurrent(job: JobSnapshot): Promise<void>;
};

type AcceptedCheckpointRetainer = {
  ensureAcceptedCheckpointRetention(job: JobSnapshot): Promise<void>;
};

export class ArkivRetentionMonitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(private readonly input: {
    jobs: JobStore;
    authority: ConfirmedSnapshotReader;
    retainer: AcceptedCheckpointRetainer;
    intervalMs?: number;
    onError?: (jobId: string, error: unknown) => void;
  }) {
    const intervalMs = input.intervalMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw new Error("ARKIV_RETENTION_INTERVAL_INVALID");
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.input.intervalMs ?? 24 * 60 * 60 * 1000);
    this.timer.unref();
    void this.runOnce();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      for (const job of await this.input.jobs.list()) {
        if (job.task.acceptedHead.sequence < 1
          || job.terms.cutoff + CHECKPOINT_RETENTION_MARGIN_DAYS * 24 * 60 * 60 < nowSeconds) continue;
        try {
          await this.input.authority.assertSnapshotCurrent(job);
          await this.input.retainer.ensureAcceptedCheckpointRetention(job);
        } catch (error) {
          try {
            this.input.onError?.(job.terms.jobId, error);
          } catch {
            // Logging callbacks must not stop renewal checks for later jobs.
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
