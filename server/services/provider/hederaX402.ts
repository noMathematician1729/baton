import { createHash } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { PrivateKey, createClientHederaSigner } from "@x402/hedera";
import { wrapFetchWithPayment } from "@x402/fetch";

export type HederaPaymentConfig = {
  accountId: string;
  privateKey: string;
  network: "hedera:testnet" | "hedera:mainnet";
};

export type PaidOutput = {
  operationId: string;
  output: Uint8Array;
  outputDigest: string;
  paymentResponse: string | null;
};

export function createHederaPaymentFetch(config: HederaPaymentConfig): typeof fetch {
  if (!config.accountId || !config.privateKey) throw new Error("Hedera payer account and private key are required");
  const signer = createClientHederaSigner(
    config.accountId,
    PrivateKey.fromString(config.privateKey),
    { network: config.network },
  );
  const client = new x402Client().register(config.network, new ExactHederaScheme(signer));
  return wrapFetchWithPayment(fetch, client);
}

export async function requestPaidOutput(input: {
  fetchWithPayment: typeof fetch;
  url: string;
  operationId: string;
  inputDigest: string;
  body: Uint8Array;
  timeoutMs?: number;
}): Promise<PaidOutput> {
  if (!input.operationId.trim()) throw new Error("A stable operation ID is required");
  if (!/^0x[\da-f]{64}$/i.test(input.inputDigest)) throw new Error("Input digest must be a SHA-256 hex digest");
  const response = await input.fetchWithPayment(input.url, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "idempotency-key": input.operationId,
      "x-baton-operation-id": input.operationId,
      "x-baton-input-digest": input.inputDigest,
    },
    body: Buffer.from(input.body),
    signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
  });
  if (!response.ok) throw new Error("Paid provider returned HTTP " + response.status + " for operation " + input.operationId);
  const output = new Uint8Array(await response.arrayBuffer());
  const outputDigest = "0x" + createHash("sha256").update(output).digest("hex");
  return {
    operationId: input.operationId,
    output,
    outputDigest,
    paymentResponse: response.headers.get("PAYMENT-RESPONSE"),
  };
}
