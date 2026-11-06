import { createHash } from "node:crypto";
import type { GatewayOperation } from "../../src/protocol/v1.js";
import type {
  PaymentProvider,
  PaymentReconciliation,
  PaymentResult,
  ProviderPaymentRequest,
} from "../../src/services/gateway/gateway.js";
import { MAX_PROVIDER_INPUT_BYTES } from "../../src/services/gateway/gateway.js";
import { ArkivPaidOutputStore } from "./arkivPaidOutput.js";
import type { PaidOutput } from "./hederaX402.js";

export type ProviderSettlementLookup =
  | { status: "settled"; providerReceipt: string; settledAmount: bigint; outputDigest?: string }
  | { status: "not-settled" }
  | { status: "unknown" };

/** Concrete gateway adapter; the service client must enforce idempotent submit and authoritative lookup. */
export interface HederaPaidServiceClient {
  submit(request: ProviderPaymentRequest): Promise<PaidOutput>;
  lookup(operation: GatewayOperation): Promise<ProviderSettlementLookup>;
  retrieveOutput(operation: GatewayOperation): Promise<Uint8Array>;
}

export class HederaX402PaymentProvider implements PaymentProvider {
  public constructor(
    private readonly service: HederaPaidServiceClient,
    private readonly outputs: ArkivPaidOutputStore,
  ) {}

  public async submit(request: ProviderPaymentRequest): Promise<PaymentResult> {
    if (!request.inputBytes) throw new Error("PROVIDER_INPUT_REQUIRED");
    if (request.inputBytes.byteLength === 0 || request.inputBytes.byteLength > MAX_PROVIDER_INPUT_BYTES) {
      throw new Error("PROVIDER_INPUT_SIZE_LIMIT_EXCEEDED");
    }
    const paid = await this.service.submit(request);
    if (paid.operationId !== request.operationId) throw new Error("PROVIDER_OPERATION_ID_MISMATCH");
    if (!paid.providerReceipt.trim()) throw new Error("PROVIDER_RECEIPT_REQUIRED");
    assertAmount(paid.settledAmount, request.amount);
    if (sha256(paid.output) !== paid.outputDigest.toLowerCase()) throw new Error("PROVIDER_OUTPUT_DIGEST_MISMATCH");
    return this.persist(request, paid.output, paid.providerReceipt, paid.settledAmount);
  }

  public async reconcile(operation: GatewayOperation): Promise<PaymentReconciliation> {
    const settlement = await this.service.lookup(operation);
    if (settlement.status !== "settled") return settlement;
    if (!settlement.providerReceipt.trim()) throw new Error("PROVIDER_RECEIPT_REQUIRED");
    if (operation.providerReceipt && operation.providerReceipt !== settlement.providerReceipt) {
      throw new Error("PROVIDER_SETTLEMENT_RECEIPT_CONFLICT");
    }
    assertAmount(settlement.settledAmount, operation.amount);
    const output = await this.service.retrieveOutput(operation);
    if (settlement.outputDigest && sha256(output) !== settlement.outputDigest.toLowerCase()) {
      throw new Error("PROVIDER_OUTPUT_DIGEST_MISMATCH");
    }
    const result = await this.persist(operation, output, settlement.providerReceipt, settlement.settledAmount);
    return { status: "settled", result };
  }

  public async retrieveOutput(operation: GatewayOperation): Promise<Uint8Array> {
    if (operation.state !== "OUTPUT_AVAILABLE" || !operation.outputRef || !operation.outputDigest) {
      throw new Error("PAID_OUTPUT_NOT_AVAILABLE");
    }
    return this.outputs.get({
      jobId: operation.jobId,
      taskId: operation.taskId,
      operationId: operation.operationId,
      outputRef: operation.outputRef,
      expectedDigest: operation.outputDigest,
    });
  }

  private async persist(
    request: Pick<ProviderPaymentRequest, "jobId" | "taskId" | "operationId">,
    output: Uint8Array,
    providerReceipt: string,
    settledAmount: bigint,
  ): Promise<PaymentResult> {
    const stored = await this.outputs.put({
      jobId: request.jobId,
      taskId: request.taskId,
      operationId: request.operationId,
      bytes: output,
    });
    return { providerReceipt, settledAmount, outputDigest: stored.outputDigest as `0x${string}`, outputRef: stored.outputRef };
  }
}

function assertAmount(settledAmount: bigint, reservedMaximum: bigint): void {
  if (settledAmount <= 0n || settledAmount > reservedMaximum) {
    throw new Error("SETTLED_AMOUNT_OUT_OF_RANGE");
  }
}

function sha256(bytes: Uint8Array): string {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}
