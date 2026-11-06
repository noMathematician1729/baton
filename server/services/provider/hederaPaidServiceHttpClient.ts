import type { GatewayOperation } from "../../src/protocol/v1.js";
import type { ProviderPaymentRequest } from "../../src/services/gateway/gateway.js";
import { MAX_RECOVERED_ARTIFACT_BYTES } from "../../packages/storage/src/arkiv.js";
import {
  createHederaPaymentFetch,
  readBoundedOutput,
  requestPaidOutput,
  type HederaPaymentAuthorization,
  type HederaPaymentConfig,
  type HederaPaymentSession,
} from "./hederaX402.js";
import type { HederaPaidServiceClient, ProviderSettlementLookup } from "./hederaPaymentProvider.js";

export type HederaPaidServiceHttpConfig = {
  submitUrl: string;
  statusUrlTemplate: string;
  outputUrlTemplate: string;
  payment: HederaPaymentConfig;
  bearerToken?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

const MAX_PROVIDER_STATUS_BYTES = 16 * 1024;

type PaymentSessionFactory = (
  config: HederaPaymentConfig,
  authorization: HederaPaymentAuthorization,
  fetchImpl: typeof fetch,
) => HederaPaymentSession;

/**
 * HTTP adapter for the paid-service contract documented in test.md. A stable operation ID
 * is the provider's idempotency key; ambiguous status responses remain unknown.
 */
export class HederaPaidServiceHttpClient implements HederaPaidServiceClient {
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  public constructor(
    private readonly config: HederaPaidServiceHttpConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly paymentSessionFactory: PaymentSessionFactory = createHederaPaymentFetch,
  ) {
    assertUrl(config.submitUrl);
    assertUrlTemplate(config.statusUrlTemplate);
    assertUrlTemplate(config.outputUrlTemplate);
    if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1)) {
      throw new Error("PAID_PROVIDER_TIMEOUT_INVALID");
    }
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxOutputBytes = config.maxOutputBytes ?? MAX_RECOVERED_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1
      || this.maxOutputBytes > MAX_RECOVERED_ARTIFACT_BYTES) {
      throw new Error("PAID_OUTPUT_SIZE_LIMIT_INVALID");
    }
    if (config.bearerToken !== undefined && !config.bearerToken.trim()) {
      throw new Error("PAID_PROVIDER_TOKEN_INVALID");
    }
    this.headers = {
      accept: "application/json",
      ...(config.bearerToken ? { authorization: `Bearer ${config.bearerToken}` } : {}),
    };
  }

  public async submit(request: ProviderPaymentRequest) {
    if (request.providerId !== "hedera-x402") throw new Error("PAID_PROVIDER_ID_NOT_SUPPORTED");
    if (request.network !== this.config.payment.network) throw new Error("X402_NETWORK_POLICY_MISMATCH");
    if (!request.inputBytes) throw new Error("PROVIDER_INPUT_REQUIRED");
    const session = this.paymentSessionFactory(this.config.payment, {
      network: this.config.payment.network,
      asset: request.asset,
      payee: request.payee,
      feePayer: this.config.payment.accountId,
      maxAmount: request.amount,
    }, this.fetchImpl);
    return requestPaidOutput({
      session,
      url: this.config.submitUrl,
      operationId: request.operationId,
      inputDigest: request.inputDigest,
      body: request.inputBytes,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      headers: this.headers,
    });
  }

  public async lookup(operation: GatewayOperation): Promise<ProviderSettlementLookup> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.operationUrl(this.config.statusUrlTemplate, operation.operationId), {
        method: "GET",
        headers: this.headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { status: "unknown" };
    }
    if (!response.ok) return { status: "unknown" };
    let body: unknown;
    try {
      const bytes = await readBoundedOutput(response, MAX_PROVIDER_STATUS_BYTES);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { status: "unknown" };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "unknown" };
    const result = body as Record<string, unknown>;
    if (result.status === "not-settled") return { status: "not-settled" };
    if (result.status !== "settled"
      || typeof result.providerReceipt !== "string" || !result.providerReceipt.trim()
      || typeof result.settledAmount !== "string" || !/^\d{1,78}$/.test(result.settledAmount)
      || BigInt(result.settledAmount) <= 0n
      || (result.outputDigest !== undefined && (typeof result.outputDigest !== "string"
        || !/^0x[\da-f]{64}$/i.test(result.outputDigest)))) return { status: "unknown" };
    return {
      status: "settled",
      providerReceipt: result.providerReceipt,
      settledAmount: BigInt(result.settledAmount),
      ...(typeof result.outputDigest === "string" ? { outputDigest: result.outputDigest } : {}),
    };
  }

  public async retrieveOutput(operation: GatewayOperation): Promise<Uint8Array> {
    const response = await this.fetchImpl(this.operationUrl(this.config.outputUrlTemplate, operation.operationId), {
      method: "GET",
      headers: { ...this.headers, accept: "application/octet-stream", "x-baton-operation-id": operation.operationId },
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`PAID_OUTPUT_HTTP_${response.status}`);
    if (response.headers.get("x-baton-operation-id") !== operation.operationId) {
      throw new Error("PAID_OUTPUT_OPERATION_BINDING_MISMATCH");
    }
    const bytes = await readBoundedOutput(response, this.maxOutputBytes);
    if (bytes.byteLength === 0) throw new Error("PAID_OUTPUT_EMPTY");
    return bytes;
  }

  private operationUrl(template: string, operationId: string): string {
    return template.replace("{operationId}", encodeURIComponent(operationId));
  }
}

function assertUrlTemplate(value: string): void {
  if (value.split("{operationId}").length !== 2) throw new Error("PAID_PROVIDER_URL_TEMPLATE_INVALID");
  assertUrl(value.replace("{operationId}", "operation-id"));
}

function assertUrl(value: string): void {
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
