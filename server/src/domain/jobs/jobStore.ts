import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  deserialise,
  CHECKPOINT_SCHEMA_VERSION,
  digest,
  EMPTY_HEAD,
  newId,
  nowSeconds,
  DEFAULT_PAYMENT_NETWORK,
  DEFAULT_PAYMENT_PAYEE,
  DEFAULT_PAYMENT_PROVIDER_ID,
  type CheckpointHead,
  type Hex,
  type JobSnapshot,
  type JobStatus,
  type JobTerms,
  type RewardCredit,
  normalizeServicePolicy,
  serialise,
} from "../../protocol/v1.js";

type StoreFile = { version: 1; jobs: Record<string, JobSnapshot> };

export type JobStorePersist = (filePath: string, contents: string) => Promise<void>;
export type GatewayReopenProof = {
  state: "RUNNING";
  worker: Hex;
  epoch: number;
  generation: number;
};

export type CreateJobInput = {
  chainJobId?: Hex;
  chainTaskId?: Hex;
  termsHash?: Hex;
  buyer: Hex;
  rewardToken: Hex;
  verifier: Hex;
  rewards: bigint[];
  serviceBudget: bigint;
  serviceAsset: string;
  approvedServices: string[];
  perRequestCap: bigint;
  paymentProviderId?: string;
  paymentNetwork?: string;
  paymentPayee?: string;
  cutoff?: number;
};

export class JobStore {
  private readonly filePath: string;
  private state: StoreFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    filePath: string,
    private readonly persistFile: JobStorePersist = persistAtomicJson,
  ) {
    this.filePath = filePath;
  }

  public async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.state = normalizeStorePolicies(deserialise<StoreFile>(await JSON.parse(await readFile(this.filePath, "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const initial: StoreFile = { version: 1, jobs: {} };
      await this.persist(initial);
      this.state = initial;
    }
  }

  public async reset(): Promise<void> {
    await this.mutate((state) => { state.jobs = {}; });
  }

  public async create(input: CreateJobInput): Promise<JobSnapshot> {
    return this.importInitial(this.prepareCreate(input));
  }

  public prepareCreate(input: CreateJobInput): JobSnapshot {
    if (input.rewards.length === 0) throw new Error("MILESTONES_REQUIRED");
    if (input.rewards.some((amount) => amount <= 0n)) throw new Error("REWARD_MUST_BE_POSITIVE");
    if (input.serviceBudget < 0n || input.perRequestCap <= 0n) throw new Error("INVALID_SERVICE_POLICY");
    const cutoff = input.cutoff ?? nowSeconds() + 86_400;
    if (!Number.isSafeInteger(cutoff) || cutoff <= nowSeconds()) throw new Error("JOB_CUTOFF_INVALID");
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
      deadline: cutoff,
      milestones,
    };
    const terms: JobTerms = {
      jobId,
      buyer: input.buyer,
      rewardToken: input.rewardToken,
      termsHash: input.termsHash ?? digest({ buyer: input.buyer, rewardToken: input.rewardToken, task, serviceBudget: input.serviceBudget }),
      taskGraphHash: digest({ taskId, dependencies: [] }),
      cutoff,
      verifier: input.verifier,
      serviceBudget: input.serviceBudget,
      serviceAsset: input.serviceAsset,
      task,
    };
    return {
      chainJobId: input.chainJobId,
      chainTaskId: input.chainTaskId,
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
      servicePolicy: normalizeServicePolicy({
        providerId: input.paymentProviderId,
        network: input.paymentNetwork,
        payee: input.paymentPayee,
        asset: input.serviceAsset,
        budget: input.serviceBudget,
        perRequestCap: input.perRequestCap,
        approvedServices: [...new Set(input.approvedServices)],
        policyVersion: "service-policy.v2",
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  public async importInitial(snapshot: JobSnapshot): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const jobId = snapshot.terms.jobId;
      const existing = state.jobs[jobId];
      if (existing) {
        if (digest(existing) !== digest(snapshot)) throw new Error("JOB_PROVISIONING_CONFLICT");
        return existing;
      }
      state.jobs[jobId] = structuredClone(snapshot);
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

  public async assign(jobId: string, worker: Hex, confirmedOnChain = false): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, jobId);
      if (!confirmedOnChain && nowSeconds() >= job.terms.cutoff) throw new Error("JOB_DEADLINE_PASSED");
      if (job.task.status === "FUNDED" && job.task.epoch === 1
        && job.task.assignedWorker?.toLowerCase() === worker.toLowerCase()) return job;
      if (job.task.status !== "FUNDED" || job.task.assignedWorker) throw new Error("TASK_NOT_ASSIGNABLE");
      job.task.assignedWorker = worker;
      job.task.epoch = 1;
      touch(job);
      return job;
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
    confirmedOnChain?: boolean;
  }): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, input.jobId);
      if (job.terms.task.taskId !== input.taskId) throw new Error("TASK_ID_MISMATCH");
      assertWorker(job, input.worker, input.epoch);
      if (!input.confirmedOnChain && nowSeconds() >= Math.min(job.terms.cutoff, job.terms.task.deadline)) {
        throw new Error("JOB_DEADLINE_PASSED");
      }
      if (job.task.drained || job.task.status !== "FUNDED") throw new Error("TASK_NOT_OPEN");
      if (job.task.acceptedHead.manifestDigest !== input.expectedHead) throw new Error("STALE_HEAD");
      const milestone = job.terms.task.milestones[job.task.nextMilestone];
      if (!milestone) throw new Error("NO_MILESTONE_REMAINING");
      if (milestone.acceptanceSpecHash !== input.acceptanceSpecHash) {
        throw new Error("ACCEPTANCE_SPEC_MISMATCH");
      }
      if (!isDigest(input.expectedHead) || !isDigest(input.newHead.manifestDigest)
        || !isDigest(input.newHead.artifactManifestDigest)) throw new Error("CHECKPOINT_DIGEST_INVALID");
      if (input.newHead.manifestDigest === EMPTY_HEAD || !input.newHead.manifestRef.trim()) throw new Error("CHECKPOINT_LOCATOR_REQUIRED");
      if (input.newHead.schemaVersion !== "checkpoint.v1") throw new Error("CHECKPOINT_SCHEMA_UNSUPPORTED");
      if (!Number.isSafeInteger(input.newHead.sequence) || input.newHead.sequence !== job.task.acceptedHead.sequence + 1) {
        throw new Error("CHECKPOINT_SEQUENCE_INVALID");
      }
      const expectedParent = input.expectedHead.toLowerCase() === EMPTY_HEAD ? null : input.expectedHead.toLowerCase();
      const candidateParent = input.newHead.previousAcceptedHead?.toLowerCase() ?? null;
      if (input.newHead.previousAcceptedHead === undefined || candidateParent !== expectedParent) {
        throw new Error("CHECKPOINT_PARENT_MISMATCH");
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

  /** Reconcile one milestone accepted on-chain while the buyer gateway was draining. */
  public async reconcileConfirmedMilestone(input: {
    jobId: string;
    producer: Hex;
    producerEpoch: number;
    newHead: CheckpointHead;
    nextMilestone: number;
    totalCredited: bigint;
  }): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, input.jobId);
      if (!job.task.drained || job.task.status !== "DRAINED") throw new Error("TASK_NOT_DRAINED");
      if (job.task.assignedWorker?.toLowerCase() !== input.producer.toLowerCase()
        || job.task.epoch !== input.producerEpoch) throw new Error("ONCHAIN_ASSIGNMENT_CHANGED");
      if (input.nextMilestone !== job.task.nextMilestone + 1) throw new Error("ONCHAIN_ACCEPTED_MILESTONE_GAP");
      if (!isDigest(input.newHead.manifestDigest) || input.newHead.manifestDigest.toLowerCase() === EMPTY_HEAD
        || !isDigest(input.newHead.artifactManifestDigest) || !input.newHead.manifestRef.trim()) {
        throw new Error("CHECKPOINT_BINDING_INVALID");
      }
      if (input.newHead.schemaVersion !== CHECKPOINT_SCHEMA_VERSION
        || input.newHead.sequence !== job.task.acceptedHead.sequence + 1) {
        throw new Error("CHECKPOINT_SEQUENCE_INVALID");
      }
      const expectedParent = job.task.acceptedHead.manifestDigest.toLowerCase() === EMPTY_HEAD
        ? null
        : job.task.acceptedHead.manifestDigest.toLowerCase();
      if ((input.newHead.previousAcceptedHead?.toLowerCase() ?? null) !== expectedParent) {
        throw new Error("CHECKPOINT_PARENT_MISMATCH");
      }
      const milestone = job.terms.task.milestones[job.task.nextMilestone];
      if (!milestone) throw new Error("NO_MILESTONE_REMAINING");
      const creditedBefore = job.credits.reduce((total, credit) => total + credit.amount, 0n);
      if (input.totalCredited !== creditedBefore + milestone.reward) throw new Error("ONCHAIN_ACCOUNTING_MISMATCH");

      job.task.acceptedHead = input.newHead;
      job.task.nextMilestone = input.nextMilestone;
      job.credits.push({
        id: newId("credit"),
        worker: input.producer,
        milestoneId: milestone.id,
        amount: milestone.reward,
        claimed: false,
      });
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
      touch(job);
      return job;
    });
  }

  public async pause(jobId: string): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, jobId);
      if (job.task.status === "CLOSED") throw new Error("TASK_CLOSED");
      if (job.task.drained) throw new Error("TASK_DRAINED");
      job.task.status = "PAUSED";
      touch(job);
      return job;
    });
  }

  public async resume(jobId: string): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, jobId);
      if (job.task.status !== "PAUSED") throw new Error("TASK_NOT_PAUSED");
      if (job.task.drained) throw new Error("TASK_DRAINED");
      job.task.status = "FUNDED";
      touch(job);
      return job;
    });
  }

  /** Reopen only after the durable gateway coordinator confirms the transition. */
  public async reopen(jobId: string, proof: GatewayReopenProof): Promise<JobSnapshot> {
    return this.mutate((state) => {
      const job = requireJob(state, jobId);
      if (job.task.status === "CLOSED" || job.task.status === "COMPLETED") throw new Error("TASK_NOT_OPEN");
      if (proof.state !== "RUNNING" || !Number.isSafeInteger(proof.generation) || proof.generation <= 0) {
        throw new Error("GATEWAY_REOPEN_PROOF_INVALID");
      }
      if (!job.task.drained) {
        if (job.task.assignedWorker?.toLowerCase() === proof.worker.toLowerCase() && job.task.epoch === proof.epoch
          && job.task.status === "FUNDED") return job;
        throw new Error("TASK_NOT_DRAINED");
      }
      if (job.task.assignedWorker?.toLowerCase() !== proof.worker.toLowerCase()) throw new Error("WORKER_NOT_ASSIGNED");
      if (job.task.epoch !== proof.epoch) throw new Error("STALE_EPOCH");
      job.task.drained = false;
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

  /** Mark rewards claimed only after confirmed escrow accounting matches the local worker credits. */
  public async reconcileConfirmedClaim(
    jobId: string,
    worker: Hex,
    onChainCredits: bigint,
    onChainWithdrawnCredits: bigint,
  ): Promise<{ amount: bigint; credits: RewardCredit[] }> {
    return this.mutate((state) => {
      const job = requireJob(state, jobId);
      const workerCredits = job.credits.filter((credit) => credit.worker.toLowerCase() === worker.toLowerCase());
      const earned = workerCredits.reduce((total, credit) => total + credit.amount, 0n);
      const claimed = workerCredits.filter((credit) => credit.claimed).reduce((total, credit) => total + credit.amount, 0n);
      if (onChainCredits !== earned) throw new Error("ONCHAIN_WORKER_CREDIT_MISMATCH");
      if (onChainWithdrawnCredits === claimed) return { amount: 0n, credits: [] };
      if (onChainWithdrawnCredits !== earned) throw new Error("ONCHAIN_WORKER_WITHDRAWAL_MISMATCH");

      const unclaimed = workerCredits.filter((credit) => !credit.claimed);
      const amount = unclaimed.reduce((total, credit) => total + credit.amount, 0n);
      for (const credit of unclaimed) credit.claimed = true;
      touch(job);
      return { amount, credits: unclaimed };
    });
  }

  private async mutate<T>(fn: (state: StoreFile) => T): Promise<T> {
    const task = this.queue.then(async () => {
      await this.ready();
      const candidate = structuredClone(this.state as StoreFile);
      const result = fn(candidate);
      await this.persist(candidate);
      this.state = candidate;
      return structuredClone(result);
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async ready(): Promise<void> {
    if (!this.state) await this.init();
  }

  private async persist(state: StoreFile): Promise<void> {
    await this.persistFile(this.filePath, JSON.stringify(serialise(state), null, 2));
  }
}

async function persistAtomicJson(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, filePath);
}

function normalizeStorePolicies(state: StoreFile): StoreFile {
  for (const job of Object.values(state.jobs)) {
    job.servicePolicy = normalizeServicePolicy(job.servicePolicy);
  }
  return state;
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
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sequence: 0,
    previousAcceptedHead: null,
  };
}

function isDigest(value: string): boolean {
  return /^0x[\da-f]{64}$/i.test(value);
}

export function statusIsOpen(status: JobStatus): boolean {
  return status === "FUNDED" || status === "DRAINED";
}
