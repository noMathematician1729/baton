import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import type { TaskSpec } from "../orchestrator/taskTemplate.js";

/** Journal entry for one externally visible operation (Sepolia tx, key grant, ENS record...). */
export type OperationRecord = {
  key: string;
  network: "sepolia" | "arkiv" | "key-service" | "local";
  intent: string;
  status: "pending" | "submitted" | "confirmed" | "failed" | "skipped";
  txHash?: Hex;
  rawTx?: Hex;
  result?: Record<string, unknown>;
  error?: string;
  updatedAt: string;
};

export type WorkerEvent = { at: string; state: string; detail?: Record<string, unknown> };

export type WorkerRecord = {
  workerId: string;
  address: Address;
  walletVerifiedAt: string;
  runtime: { kind: string; account?: Record<string, unknown> | null };
  capabilities: string[];
  pid?: number;
  connection: "starting" | "login_required" | "authenticated" | "available" | "busy" | "stopped" | "error";
  loginUrl?: string;
  smoke?: { passed: boolean; at: string; threadId?: string; turnId?: string; detail?: Record<string, unknown> };
  lastHeartbeatAt?: string;
  currentJobId?: Hex;
  lastError?: string;
  events: WorkerEvent[];
};

export type CheckpointRecord = {
  milestone: number;
  sequence: number;
  epoch: number;
  writer: Address;
  workerId: string;
  manifestDigest: Hex;
  manifestRef: Hex;
  keyId: string;
  arkivTx?: Hex;
  arkivOwner?: Address;
  arkivExpiresAt?: string;
  newArtifacts: string[];
  status: "verified" | "rejected" | "accepted";
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  offer: Record<string, string | number>;
  signature: Hex;
  submittedAt: string;
  acceptTx?: Hex;
  recoveredFrom?: unknown;
};

export type AssignmentRecord = {
  workerId: string;
  address: Address;
  epoch: number;
  ensName: string;
  status: "provisioning" | "ready" | "active" | "replaced" | "completed";
  assignedAt: string;
  endedAt?: string;
};

export type TakeoverRecord = {
  fromWorkerId: string;
  toWorkerId: string;
  requestedAt: string;
  expectedHead: Hex;
  fromEpoch: number;
  ackRequest: { nonce: string; expiry: number; compatibilityReport: Hex; servicePolicy: Hex; epoch: number; expectedHead: Hex };
  ack?: { message: Record<string, string>; signature: Hex };
  status: "requested" | "ack_signed" | "taken_over" | "completed" | "failed";
};

export type JobRecord = {
  jobId: Hex;
  taskId: Hex;
  termsHash: Hex;
  createdAt: string;
  spec: TaskSpec;
  rewardsWei: string[];
  acceptanceSpecHashes: Hex[];
  escrow: Address;
  rewardToken: Address;
  buyer: Address;
  ens: {
    parent: string;
    label: string;
    name: string;
    registry?: Address;
    resolver?: Address;
    authority?: Address;
    workerNames: Record<string, { name: string; address: Address; label: string }>;
  };
  phase: "provisioning" | "ready" | "running" | "takeover" | "completing" | "completed" | "failed";
  readiness: { resources: boolean; funding: boolean; execution: boolean };
  epoch: number;
  activeWorkerId?: string;
  assignments: AssignmentRecord[];
  checkpoints: CheckpointRecord[];
  /** Per-epoch content keys, wrapped with the buyer's key-encryption key. */
  contentKeys: Record<string, { keyId: string; wrapped: string }>;
  takeover?: TakeoverRecord;
  ops: Record<string, OperationRecord>;
  lastError?: string;
};

type StoreFile = { version: 1; workers: Record<string, WorkerRecord>; jobs: Record<string, JobRecord>; globalOps: Record<string, OperationRecord>; challenges: Record<string, { nonce: string; at: string }> };

export class CoreStore {
  private state: StoreFile | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async load(): Promise<StoreFile> {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(await readFile(this.filePath, "utf8")) as StoreFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { version: 1, workers: {}, jobs: {}, globalOps: {}, challenges: {} };
    }
    return this.state;
  }

  public async read<T>(reader: (state: StoreFile) => T): Promise<T> {
    return reader(await this.load());
  }

  /** Serialized read-modify-write; the file is replaced atomically after each mutation. */
  public mutate<T>(mutator: (state: StoreFile) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.load();
      const result = mutator(state);
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(temp, this.filePath);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
