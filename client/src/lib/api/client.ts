export type Hex = `0x${string}`;

export type CheckpointHead = {
  manifestDigest: Hex;
  manifestRef: string;
  artifactManifestDigest: Hex;
  schemaVersion: string;
  sequence: number;
  previousAcceptedHead: Hex | null;
};

export type JobSnapshot = {
  chainJobId?: Hex;
  chainTaskId?: Hex;
  terms: {
    jobId: string;
    buyer: Hex;
    rewardToken: Hex;
    termsHash: Hex;
    taskGraphHash: Hex;
    cutoff: number;
    verifier: Hex;
    serviceBudget: bigint;
    serviceAsset: string;
    task: {
      taskId: string;
      requiredCapabilitiesHash: Hex;
      acceptanceSpecHash: Hex;
      deadline: number;
      milestones: { id: string; reward: bigint; acceptanceSpecHash: Hex; progressPercent: number }[];
    };
  };
  task: {
    taskId: string;
    assignedWorker: Hex | null;
    epoch: number;
    acceptedHead: CheckpointHead;
    nextMilestone: number;
    status: "FUNDED" | "PAUSED" | "DRAINED" | "COMPLETED" | "CLOSED";
    drained: boolean;
  };
  credits: { id: string; worker: Hex; milestoneId: string; amount: bigint; claimed: boolean }[];
  servicePolicy: {
    providerId: string;
    network: string;
    payee: Hex | string;
    asset: string;
    budget: bigint;
    perRequestCap: bigint;
    approvedServices: string[];
    policyVersion: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type RuntimeStatus = {
  api: "ready";
  contentStore: "arkiv" | "unconfigured";
  configuration: {
    arkiv: boolean;
    sepolia: boolean;
    sepoliaMutations?: boolean;
    takeoverPolicyEnabled?: boolean;
    ens: boolean;
    hederaX402: boolean;
  };
  paymentLedger: { backend: "sqlite"; implementation: "node:sqlite" };
  paymentProvider: "local-fixture" | "hedera-x402";
  confirmedChainRead?: { blockNumber: string; blockHash: Hex; confirmationBlocks: number } | null;
};

export type ProtocolInfo = {
  protocol: "baton.protocol.v1";
  digest: "sha256";
  emptyHead: Hex;
  confirmationBlocks: number;
  networkMode: "local-fixture" | "testnet-configured";
  gatewayAuth?: { chainId: number; verifyingContract: Hex | null };
};

export type Operation = {
  operationId: string;
  jobId: string;
  taskId: string;
  worker: Hex;
  epoch: number;
  service: string;
  amount: bigint;
  asset: string;
  state: string;
  providerReceipt?: string;
  outputDigest?: Hex;
  outputRef?: string;
  failureCode?: string;
  updatedAt: string;
};

export type LedgerBalance = { deposits: bigint; available: bigint; reserved: bigint; settledSpend: bigint; returnedFunds: bigint };
export type JobDetail = {
  job: JobSnapshot;
  balance?: LedgerBalance | null;
  operations?: Operation[];
  gatewayControl?: { state: string; epoch: number; generation: number } | null;
};

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

const API_URL = (import.meta.env.VITE_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      cache: "no-store",
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "Could not reach the BATON API", 0);
  }
  const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `API returned ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return deserialise(payload) as T;
}

export function deserialise<T>(value: unknown): T {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1)) as T;
  if (Array.isArray(value)) return value.map((item) => deserialise(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deserialise(item)])) as T;
  }
  return value as T;
}

export function serialise(value: unknown): unknown {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return value.map(serialise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialise(item)]));
  }
  return value;
}

export const api = {
  health: (signal?: AbortSignal) => request<{ status: "ok"; service: string; timestamp: string }>("/api/health", { signal }),
  status: (signal?: AbortSignal) => request<RuntimeStatus>("/api/status", { signal }),
  protocol: (signal?: AbortSignal) => request<ProtocolInfo>("/api/protocol", { signal }),
  jobs: (signal?: AbortSignal) => request<JobSnapshot[]>("/api/jobs", { signal }),
  job: (jobId: string, signal?: AbortSignal) => request<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal }),
  createLocalJob: (body: { buyer?: Hex; rewards?: string[]; serviceBudget?: string; perRequestCap?: string; serviceAsset?: string }) =>
    request<JobSnapshot>("/api/jobs", { method: "POST", body: JSON.stringify(body) }),
  importJob: (body: Record<string, unknown>) =>
    request<JobSnapshot>("/api/jobs/import", { method: "POST", body: JSON.stringify(serialise(body)) }),
  assign: (jobId: string, body: Record<string, unknown>) =>
    request<JobSnapshot>(`/api/jobs/${encodeURIComponent(jobId)}/assign`, { method: "POST", body: JSON.stringify(serialise(body)) }),
  action: (jobId: string, action: "pause" | "resume" | "drain" | "cancel-drain", body: Record<string, unknown>) =>
    request<JobSnapshot>(`/api/jobs/${encodeURIComponent(jobId)}/${action}`, { method: "POST", body: JSON.stringify(serialise(body)) }),
  acceptCheckpoint: (jobId: string, body: Record<string, unknown>) =>
    request<JobSnapshot>(`/api/jobs/${encodeURIComponent(jobId)}/checkpoints`, { method: "POST", body: JSON.stringify(serialise(body)) }),
  takeover: (jobId: string, body: Record<string, unknown>) =>
    request<JobSnapshot>(`/api/jobs/${encodeURIComponent(jobId)}/takeover`, { method: "POST", body: JSON.stringify(serialise(body)) }),
  takeoverAck: (jobId: string, body: Record<string, unknown>) =>
    request<{ accepted: boolean; expiresAt: number }>(`/api/jobs/${encodeURIComponent(jobId)}/takeover-ack`, { method: "POST", body: JSON.stringify(serialise(body)) }),
  operations: (jobId: string) =>
    request<Operation[]>(`/api/jobs/${encodeURIComponent(jobId)}/services/operations`),
  quote: (jobId: string, service: string, amount: string) =>
    request<{ approved: boolean; reason?: string; balance?: LedgerBalance }>(`/api/jobs/${encodeURIComponent(jobId)}/services/quote`, {
      method: "POST", body: JSON.stringify({ service, amount }),
    }),
};
