import { createHash } from "node:crypto";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { PrivateKey, createClientHederaSigner } from "@x402/hedera";
import { wrapFetchWithPayment } from "@x402/fetch";

export type HederaPaymentConfig = {
  accountId: string;
  privateKey: string;
  network: "hedera:testnet" | "hedera:mainnet";
};

export type HederaPaymentAuthorization = {
  network: HederaPaymentConfig["network"];
  asset: string;
  payee: string;
  feePayer: string;
  maxAmount: bigint;
};

export type HederaPaymentSession = {
  fetchWithPayment: typeof fetch;
  authorization: HederaPaymentAuthorization;
  selectedAmount(): bigint | undefined;
};

export type PaidOutput = {
  operationId: string;
  output: Uint8Array;
  outputDigest: string;
  providerReceipt: string;
  settledAmount: bigint;
  paymentResponse: string;
};

/** A session is per operation so challenge authorization cannot bleed across concurrent purchases. */
export function createHederaPaymentFetch(
  config: HederaPaymentConfig,
  authorization: HederaPaymentAuthorization,
  fetchImpl: typeof fetch = fetch,
): HederaPaymentSession {
  if (!config.accountId || !config.privateKey) throw new Error("HEDERA_PAYER_CONFIG_REQUIRED");
  assertAuthorization(config, authorization);
  const signer = createClientHederaSigner(
    config.accountId,
    PrivateKey.fromString(config.privateKey),
    { network: config.network },
  );
  let selectedAmount: bigint | undefined;
  const client = new x402Client((version, requirements) => {
    const selected = selectHederaPaymentRequirement(version, requirements, authorization);
    selectedAmount = BigInt(selected.amount);
    return selected;
  }).register(config.network, new ExactHederaScheme(signer));
  return {
    fetchWithPayment: wrapFetchWithPayment(fetchImpl, client),
    authorization,
    selectedAmount: () => selectedAmount,
  };
}

/** Reject unapproved challenge fields before the x402 client creates a payer signature. */
export function selectHederaPaymentRequirement(
  version: number,
  requirements: PaymentRequirements[],
  authorization: HederaPaymentAuthorization,
): PaymentRequirements {
  if (version !== 2) throw new Error("X402_VERSION_NOT_APPROVED");
  const matching = requirements.filter((requirement) => {
    if (requirement.scheme !== "exact"
      || requirement.network !== authorization.network
      || requirement.asset !== authorization.asset
      || requirement.payTo !== authorization.payee
      || !/^\d{1,78}$/.test(requirement.amount)
      || BigInt(requirement.amount) <= 0n
      || BigInt(requirement.amount) > authorization.maxAmount) return false;
    return requirement.extra?.feePayer === authorization.feePayer;
  });
  if (matching.length === 0) throw new Error("X402_CHALLENGE_NOT_AUTHORIZED");
  return [...matching].sort((left, right) => {
    const a = BigInt(left.amount);
    const b = BigInt(right.amount);
    return a < b ? -1 : a > b ? 1 : 0;
  })[0]!;
}

export async function requestPaidOutput(input: {
  session: HederaPaymentSession;
  url: string;
  operationId: string;
  inputDigest: string;
  body: Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<PaidOutput> {
  if (!input.operationId.trim()) throw new Error("STABLE_OPERATION_ID_REQUIRED");
  if (!/^0x[\da-f]{64}$/i.test(input.inputDigest)) throw new Error("INPUT_DIGEST_INVALID");
  if (sha256(input.body).toLowerCase() !== input.inputDigest.toLowerCase()) throw new Error("INPUT_DIGEST_MISMATCH");
  assertPaidServiceUrl(input.url);
  const response = await input.session.fetchWithPayment(input.url, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "idempotency-key": input.operationId,
      "x-baton-operation-id": input.operationId,
      "x-baton-input-digest": input.inputDigest,
      ...input.headers,
    },
    body: Buffer.from(input.body),
    redirect: "error",
    signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
  });
  if (!response.ok) throw new Error(`PAID_PROVIDER_HTTP_${response.status}`);
  const authorizedAmount = input.session.selectedAmount();
  if (authorizedAmount === undefined) throw new Error("X402_CHALLENGE_REQUIRED");

  const paymentResponse = response.headers.get("PAYMENT-RESPONSE");
  if (!paymentResponse) throw new Error("X402_SETTLEMENT_EVIDENCE_MISSING");
  let settlement: ReturnType<typeof decodePaymentResponseHeader>;
  try {
    settlement = decodePaymentResponseHeader(paymentResponse);
  } catch {
    throw new Error("X402_SETTLEMENT_EVIDENCE_INVALID");
  }
  if (settlement.success !== true
    || settlement.network !== input.session.authorization.network
    || typeof settlement.transaction !== "string"
    || settlement.transaction.trim().length === 0) {
    throw new Error("X402_SETTLEMENT_NOT_CONFIRMED");
  }
  if (settlement.amount !== undefined && (!/^\d+$/.test(settlement.amount)
    || BigInt(settlement.amount) !== authorizedAmount)) {
    throw new Error("X402_SETTLED_AMOUNT_MISMATCH");
  }

  const maxOutputBytes = input.maxOutputBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("PAID_OUTPUT_SIZE_LIMIT_INVALID");
  const output = await readBoundedOutput(response, maxOutputBytes);
  if (output.byteLength === 0 || output.byteLength > maxOutputBytes) throw new Error("PAID_OUTPUT_SIZE_LIMIT_EXCEEDED");
  const outputDigest = sha256(output);
  return {
    operationId: input.operationId,
    output,
    outputDigest,
    providerReceipt: settlement.transaction,
    settledAmount: authorizedAmount,
    paymentResponse,
  };
}

function assertAuthorization(config: HederaPaymentConfig, authorization: HederaPaymentAuthorization): void {
  if (authorization.network !== config.network) throw new Error("X402_NETWORK_POLICY_MISMATCH");
  if (!/^0\.0\.\d+$/.test(config.accountId)) throw new Error("HEDERA_PAYER_ACCOUNT_ID_INVALID");
  if (!/^0\.0\.\d+$/.test(authorization.asset)) throw new Error("X402_ASSET_ID_INVALID");
  if (!/^0\.0\.\d+$/.test(authorization.payee)) throw new Error("X402_PAYEE_ID_INVALID");
  if (!/^0\.0\.\d+$/.test(authorization.feePayer)) throw new Error("X402_FEE_PAYER_ID_INVALID");
  if (authorization.maxAmount <= 0n || authorization.maxAmount >= (1n << 256n)) {
    throw new Error("X402_MAX_AMOUNT_INVALID");
  }
}

function sha256(value: Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function assertPaidServiceUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PAID_PROVIDER_URL_INVALID");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("PAID_PROVIDER_TLS_REQUIRED");
  if (url.username || url.password || url.hash) throw new Error("PAID_PROVIDER_URL_INVALID");
}

export async function readBoundedOutput(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(maximumBytes)) {
    throw new Error("PAID_OUTPUT_SIZE_LIMIT_EXCEEDED");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("PAID_OUTPUT_SIZE_LIMIT_EXCEEDED");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
