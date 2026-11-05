import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  deserialise,
  digest,
  EMPTY_HEAD,
  newId,
  nowSeconds,
  type CheckpointHead,
  type Hex,
  type JobSnapshot,
  type JobStatus,
  type JobTerms,
  type RewardCredit,
  serialise,
} from "../../protocol/v1.js";

type StoreFile = { version: 1; jobs: Record<string, JobSnapshot> };

export type CreateJobInput = {
  chainJobId?: Hex;
  buyer: Hex;
  rewardToken: Hex;
  verifier: Hex;
  rewards: bigint[];
  serviceBudget: bigint;
  serviceAsset: string;
  approvedServices: string[];
  perRequestCap: bigint;
  cutoff?: number;
};

export class JobStore {
  private readonly filePath: string;
  private state: StoreFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  public async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.state = deserialise<StoreFile>(await JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { version: 1, jobs: {} };
      await this.persist();
    }
  }

  public async reset(): Promise<void> {
    await this.mutate((state) => { state.jobs = {}; });
  }

  public async create(input: CreateJobInput): Promise<JobSnapshot> {
    return this.mutate((state) => {
      if (input.rewards.length === 0) throw new Error("MILESTONES_REQUIRED");
      if (input.rewards.some((amount) => amount <= 0n)) throw new Error("REWARD_MUST_BE_POSITIVE");
      if (input.serviceBudget < 0n || input.perRequestCap <= 0n) throw new Error("INVALID_SERVICE_POLICY");
      const jobId = newId("job");
      const taskId = newId("task");
      const acceptanceSpecHash = digest({ taskId, rule: "output digest must match reference batch" });
      const milestones = input.rewards.map((reward, index) => ({
        id: `milestone-${index + 1}`,
        reward,
        acceptanceSpecHash,
        progressPercent: Math.round(((index + 1) / input.rewards.length) * 100),
      }));
      const task: JobTerms["task"] = {
        taskId,
        requiredCapabilitiesHash: digest(["deterministic-batch-v1"]),
        acceptanceSpecHash,
        deadline: input.cutoff ?? nowSeconds() + 86_400,
        milestones,
      };
      const terms: JobTerms = {
        jobId,
        buyer: input.buyer,
        rewardToken: input.rewardToken,
        termsHash: digest({ buyer: input.buyer, rewardToken: input.rewardToken, task, serviceBudget: input.serviceBudget }),
        taskGraphHash: digest({ taskId, dependencies: [] }),
        cutoff: input.cutoff ?? nowSeconds() + 86_400,
        verifier: input.verifier,
        serviceBudget: input.serviceBudget,
        serviceAsset: input.serviceAsset,
        task,
      };
      const snapshot: JobSnapshot = {
        chainJobId: input.chainJobId,
        terms,
        task: {
          taskId,
          assignedWorker: null,
          epoch: 0,
          acceptedHead: emptyHead(),
          nextMilestone: 0,
          status: "FUNDED",
          drained: false,
        },
        credits: [],
        servicePolicy: {
          asset: input.serviceAsset,
          budget: input.serviceBudget,
          perRequestCap: input.perRequestCap,
          approvedServices: [...new Set(input.approvedServices)],
          policyVersion: "service-policy.v1",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.jobs[jobId] = snapshot;
      return snapshot;
    });
  }

  public async get(jobId: string): Promise<JobSnapshot | undefined> {
    await this.ready();
    const job = this.state?.jobs[jobId];
    return job ? structuredClone(job) : undefined;
  }

  public async list(): Promise<JobSnapshot[]> {
    await this.ready();
    return Object.values(this.state?.jobs ?? {}).map((job) => structuredClone(job));
  }

  public async assign(jobId: string, worker: Hex): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, jobId);
      if (job.task.status !== "FUNDED" || job.task.assignedWorker) throw new Error("TASK_NOT_ASSIGNABLE");
      job.task.assignedWorker = worker;
      job.task.epoch = 1;
      touch(job);
      return job;
    });
  }

  public async acceptMilestone(input: {
    jobId: string;
    worker: Hex;
    epoch: number;
    expectedHead: Hex;
    newHead: CheckpointHead;
  }): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, input.jobId);
      assertWorker(job, input.worker, input.epoch);
      if (job.task.drained || job.task.status !== "FUNDED") throw new Error("TASK_NOT_OPEN");
      if (job.task.acceptedHead.manifestDigest !== input.expectedHead) throw new Error("STALE_HEAD");
      const milestone = job.terms.task.milestones[job.task.nextMilestone];
      if (!milestone) throw new Error("NO_MILESTONE_REMAINING");
      if (milestone.acceptanceSpecHash !== input.newHead.artifactManifestDigest) {
        throw new Error("ACCEPTANCE_SPEC_MISMATCH");
      }
      const credit: RewardCredit = {
        id: newId("credit"),
        worker: input.worker,
        milestoneId: milestone.id,
        amount: milestone.reward,
        claimed: false,
      };
      job.task.acceptedHead = input.newHead;
      job.task.nextMilestone += 1;
      job.credits.push(credit);
      if (job.task.nextMilestone === job.terms.task.milestones.length) job.task.status = "COMPLETED";
      touch(job);
      return job;
    });
  }

  public async drain(jobId: string): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, jobId);
      if (job.task.status === "CLOSED") throw new Error("TASK_CLOSED");
      if (job.task.status === "COMPLETED") throw new Error("TASK_NOT_OPEN");
      job.task.drained = true;
      job.task.status = job.task.status === "PAUSED" ? "PAUSED" : "DRAINED";
      touch(job);
      return job;
    });
  }

  public async takeover(input: {
    jobId: string;
    successor: Hex;
    expectedHead: Hex;
    expectedEpoch: number;
    compatibilityReport: Hex;
  }): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, input.jobId);
      if (!job.task.drained) throw new Error("TASK_MUST_BE_DRAINED");
      if (job.task.status === "PAUSED" || job.task.status === "COMPLETED" || job.task.status === "CLOSED") throw new Error("TASK_NOT_OPEN");
      if (job.task.acceptedHead.manifestDigest !== input.expectedHead) throw new Error("STALE_HEAD");
      if (job.task.epoch !== input.expectedEpoch) throw new Error("STALE_EPOCH");
      if (job.task.assignedWorker === input.successor) throw new Error("SUCCESSOR_ALREADY_ACTIVE");
      if (input.compatibilityReport === EMPTY_HEAD) throw new Error("COMPATIBILITY_REPORT_REQUIRED");
      job.task.assignedWorker = input.successor;
      job.task.epoch += 1;
      job.task.drained = false;
      if (job.task.status === "DRAINED") job.task.status = "FUNDED";
      touch(job);
      return job;
    });
  }

  public async pause(jobId: string): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, jobId);
      if (job.task.status === "CLOSED") throw new Error("TASK_CLOSED");
      job.task.status = "PAUSED";
      touch(job);
      return job;
    });
  }

  public async resume(jobId: string): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, jobId);
      if (job.task.status !== "PAUSED") throw new Error("TASK_NOT_PAUSED");
      job.task.status = "FUNDED";
      touch(job);
      return job;
    });
  }

  public async claim(jobId: string, worker: Hex): Promise<{ amount: bigint; credits: RewardCredit[] }> {
    return this.mutate((state) => {
      const job = requireJob(state, jobId);
      const credits = job.credits.filter((credit) => credit.worker === worker && !credit.claimed);
      if (credits.length === 0) throw new Error("NO_WITHDRAWABLE_CREDITS");
      const amount = credits.reduce((total, credit) => total + credit.amount, 0n);
      for (const credit of credits) credit.claimed = true;
      touch(job);
      return { amount, credits };
    });
  }

  private async mutate<T>(fn: (state: StoreFile) => T): Promise<T> {
    const task = this.queue.then(async () => {
      await this.ready();
      const result = fn(this.state as StoreFile);
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

function requireJob(state: StoreFile, jobId: string): JobSnapshot {
  const job = state.jobs[jobId];
  if (!job) throw new Error("JOB_NOT_FOUND");
  return job;
}

function assertWorker(job: JobSnapshot, worker: Hex, epoch: number): void {
  if (job.task.assignedWorker !== worker) throw new Error("WORKER_NOT_ASSIGNED");
  if (job.task.epoch !== epoch) throw new Error("STALE_EPOCH");
}

function touch(job: JobSnapshot): void {
  job.updatedAt = new Date().toISOString();
}

function emptyHead(): CheckpointHead {
  return {
    manifestDigest: EMPTY_HEAD as Hex,
    manifestRef: "",
    artifactManifestDigest: EMPTY_HEAD as Hex,
    schemaVersion: "checkpoint.v1",
    sequence: 0,
  };
}

export function statusIsOpen(status: JobStatus): boolean {
  return status === "FUNDED" || status === "DRAINED";
}
