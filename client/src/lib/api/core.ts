import { API_URL } from "./status";

export type CoreWorker = {
  workerId: string;
  address: string;
  runtime: { kind: string; account?: Record<string, unknown> | null };
  capabilities: string[];
  pid?: number;
  connection: "starting" | "login_required" | "authenticated" | "available" | "busy" | "stopped" | "error";
  loginUrl?: string;
  smoke?: { passed: boolean; at: string; threadId?: string };
  lastHeartbeatAt?: string;
  currentJobId?: string;
  lastError?: string;
  alive: boolean;
};

export type CoreJobSummary = {
  jobId: string;
  ensName: string;
  phase: "provisioning" | "ready" | "running" | "takeover" | "completing" | "completed" | "failed";
  epoch: number;
  activeWorkerId?: string;
  readiness: { resources: boolean; funding: boolean; execution: boolean };
  createdAt: string;
  lastError?: string;
};

export type CoreCheckpoint = {
  milestone: number;
  sequence: number;
  epoch: number;
  writer: string;
  workerId: string;
  manifestDigest: string;
  status: "verified" | "rejected" | "accepted";
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  submittedAt: string;
  acceptTx?: string;
};

export type CoreOperation = {
  key: string;
  network: string;
  intent: string;
  status: "pending" | "submitted" | "confirmed" | "failed" | "skipped";
  txHash?: string;
  error?: string;
  updatedAt: string;
};

export type CoreJob = CoreJobSummary & {
  taskId: string;
  spec: {
    title: string;
    objective: string;
    milestones: Array<{ index: number; title: string; rewardTokens: number; requiredFiles: string[] }>;
  };
  rewardsWei: string[];
  escrow: string;
  rewardToken: string;
  buyer: string;
  assignments: Array<{ workerId: string; address: string; epoch: number; ensName: string; status: string; assignedAt: string; endedAt?: string }>;
  checkpoints: CoreCheckpoint[];
  takeover?: { fromWorkerId: string; toWorkerId: string; status: string; requestedAt: string };
  ops: Record<string, CoreOperation>;
  running: boolean;
};

export type CoreReconciliation = {
  jobId: string;
  rewardPool: string;
  unallocated: string;
  outstandingCredits: string;
  totalWithdrawn: string;
  totalRefunded: string;
  conserved: boolean;
  workers: Array<{ workerId: string; address: string; epoch: number; credited: string; withdrawn: string }>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API_URL + path, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `API returned ${response.status}`);
  return body as T;
}

export async function getCoreOverview(signal?: AbortSignal) {
  const [workerResult, jobResult] = await Promise.all([
    request<{ workers: CoreWorker[] }>("/api/core/workers", { signal }),
    request<{ jobs: CoreJobSummary[] }>("/api/core/jobs", { signal }),
  ]);
  return { workers: workerResult.workers, jobs: jobResult.jobs };
}

export function getCoreJob(jobId: string, signal?: AbortSignal) {
  return request<CoreJob>(`/api/core/jobs/${encodeURIComponent(jobId)}`, { signal });
}

export function getCoreReconciliation(jobId: string, signal?: AbortSignal) {
  return request<CoreReconciliation>(`/api/core/jobs/${encodeURIComponent(jobId)}/reconcile`, { signal });
}

export function postCoreAction<T>(path: string, token: string, body?: unknown) {
  return request<T>(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-baton-buyer-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
