import { createHash, randomUUID } from "node:crypto";

/** BATON's versioned wire contract. Keep this module dependency-free so workers can vendor it. */
export const PROTOCOL_VERSION = "baton.protocol.v1" as const;
export const EMPTY_HEAD = "0x" + "00".repeat(32);
export const DIGEST_ALGORITHM = "sha256" as const;

export type Hex = `0x${string}`;
export type JobStatus = "FUNDED" | "PAUSED" | "DRAINED" | "COMPLETED" | "CLOSED";
export type OperationState =
  | "INTENT"
  | "RESERVED"
  | "SUBMITTED"
  | "SETTLED"
  | "OUTPUT_AVAILABLE"
  | "FAILED"
  | "UNKNOWN";

export type Milestone = {
  id: string;
  reward: bigint;
  acceptanceSpecHash: Hex;
  progressPercent: number;
};

export type TaskTerms = {
  taskId: string;
  requiredCapabilitiesHash: Hex;
  acceptanceSpecHash: Hex;
  deadline: number;
  milestones: Milestone[];
};

export type JobTerms = {
  jobId: string;
  buyer: Hex;
  rewardToken: Hex;
  termsHash: Hex;
  taskGraphHash: Hex;
  cutoff: number;
  verifier: Hex;
  serviceBudget: bigint;
  serviceAsset: string;
  task: TaskTerms;
};

export type CheckpointHead = {
  /** SHA-256 of the exact versioned serialized encrypted manifest envelope. */
  manifestDigest: Hex;
  /** Exact durable entity locator for the encrypted envelope. */
  manifestRef: string;
  /** Digest of the artifact manifest; distinct from the acceptance-rule commitment. */
  artifactManifestDigest: Hex;
  schemaVersion: string;
  sequence: number;
  /** Previous accepted manifest digest, null only before the first accepted checkpoint. */
  previousAcceptedHead: Hex | null;
};

export const CHECKPOINT_SCHEMA_VERSION = "checkpoint.v1" as const;

export type TaskState = {
  taskId: string;
  assignedWorker: Hex | null;
  epoch: number;
  acceptedHead: CheckpointHead;
  nextMilestone: number;
  status: JobStatus;
  drained: boolean;
};

export type RewardCredit = {
  id: string;
  worker: Hex;
  milestoneId: string;
  amount: bigint;
  claimed: boolean;
};

export type ServicePolicy = {
  providerId: string;
  network: string;
  payee: Hex;
  asset: string;
  budget: bigint;
  perRequestCap: bigint;
  approvedServices: string[];
  policyVersion: string;
};

export const DEFAULT_PAYMENT_PROVIDER_ID = "local-fixture";
export const DEFAULT_PAYMENT_NETWORK = "hedera:testnet";
export const DEFAULT_PAYMENT_PAYEE = ("0x" + "00".repeat(20)) as Hex;

export function normalizeServicePolicy(policy: Partial<ServicePolicy>): ServicePolicy {
  return {
    providerId: policy.providerId ?? DEFAULT_PAYMENT_PROVIDER_ID,
    network: policy.network ?? DEFAULT_PAYMENT_NETWORK,
    payee: policy.payee ?? DEFAULT_PAYMENT_PAYEE,
    asset: policy.asset ?? "HBAR",
    budget: policy.budget ?? 0n,
    perRequestCap: policy.perRequestCap ?? 0n,
    approvedServices: policy.approvedServices ?? [],
    policyVersion: policy.policyVersion ?? "service-policy.v1",
  };
}

export type GatewayOperation = {
  operationId: string;
  jobId: string;
  taskId: string;
  worker: Hex;
  epoch: number;
  service: string;
  inputDigest: Hex;
  requestFingerprint: Hex;
  providerId: string;
  network: string;
  payee: Hex;
  policyVersion: string;
  approvedPolicyHash: Hex;
  amount: bigint;
  asset: string;
  state: OperationState;
  nonce: string;
  createdAt: string;
  updatedAt: string;
  providerReceipt?: string;
  outputDigest?: Hex;
  outputRef?: string;
  reusedBy?: Array<{ worker: Hex; epoch: number; at: string }>;
  failureCode?: string;
};

export type JobSnapshot = {
  /** Optional bytes32 JobEscrow ID bound to this local job for live gateway checks. */
  chainJobId?: Hex;
  /** On-chain bytes32 task ID corresponding to this local task. */
  chainTaskId?: Hex;
  terms: JobTerms;
  task: TaskState;
  credits: RewardCredit[];
  servicePolicy: ServicePolicy;
  createdAt: string;
  updatedAt: string;
};

export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function digest(value: unknown): Hex {
  const bytes = typeof value === "string" ? value : canonicalJson(value);
  return `0x${createHash(DIGEST_ALGORITHM).update(bytes).digest("hex")}`;
}

export type PaymentIntentFingerprintInput = {
  jobId: string;
  taskId: string;
  providerId: string;
  network: string;
  service: string;
  inputDigest: Hex;
  amount: bigint;
  asset: string;
  payee: Hex;
  policyVersion: string;
  approvedPolicyHash: Hex;
};

/** Worker and epoch are intentionally excluded so an authorized successor can reuse a purchase. */
export function paymentIntentFingerprint(input: PaymentIntentFingerprintInput): Hex {
  return digest({
    jobId: input.jobId,
    taskId: input.taskId,
    providerId: input.providerId,
    network: input.network,
    service: input.service,
    inputDigest: input.inputDigest,
    amount: input.amount.toString(),
    asset: input.asset,
    payee: input.payee.toLowerCase(),
    policyVersion: input.policyVersion,
    approvedPolicyHash: input.approvedPolicyHash,
  });
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function serialise(value: unknown): unknown {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return value.map(serialise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialise(item)]));
  }
  return value;
}

export function deserialise<T>(value: unknown): T {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1)) as T;
  if (Array.isArray(value)) return value.map((item) => deserialise(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deserialise(item)]),
    ) as T;
  }
  return value as T;
}

export function assertHex(value: string, label: string): asserts value is Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be a 32-byte hex digest`);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
