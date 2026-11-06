import { API_URL } from "./status";

export type CoreWorker = {
  workerId: string;
  address: string;
  runtime: { kind: string; account?: Record<string, unknown> | null };
  capabilities: string[];
  managed?: boolean;
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

async function request<T>(path: string, init?: RequestInit, buyerToken?: string): Promise<T> {
  const headers = new Headers(init?.headers);
  if (buyerToken) headers.set("x-baton-buyer-token", buyerToken);
  const response = await fetch(API_URL + path, { ...init, headers });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `API returned ${response.status}`);
  return body as T;
}

export async function getCoreOverview(buyerToken: string, signal?: AbortSignal) {
  const [workerResult, jobResult] = await Promise.all([
    request<{ workers: CoreWorker[] }>("/api/core/workers", { signal }, buyerToken),
    request<{ jobs: CoreJobSummary[] }>("/api/core/jobs", { signal }, buyerToken),
  ]);
  return { workers: workerResult.workers, jobs: jobResult.jobs };
}

export function getCoreJob(jobId: string, buyerToken: string, signal?: AbortSignal) {
  return request<CoreJob>(`/api/core/jobs/${encodeURIComponent(jobId)}`, { signal }, buyerToken);
}

export function getCoreReconciliation(jobId: string, buyerToken: string) {
  return request<CoreReconciliation>(`/api/core/jobs/${encodeURIComponent(jobId)}/reconcile`, undefined, buyerToken);
}

export function postCoreAction<T>(path: string, token: string, body?: unknown) {
  return request<T>(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, token);
}
