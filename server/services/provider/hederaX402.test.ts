import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { requestPaidOutput, selectHederaPaymentRequirement, type HederaPaymentAuthorization, type HederaPaymentSession } from "./hederaX402.js";

const authorization: HederaPaymentAuthorization = {
  network: "hedera:testnet",
  asset: "0.0.429274",
  payee: "0.0.1234",
  feePayer: "0.0.5001",
  maxAmount: 5_000_000n,
};

test("Hedera x402 selects the cheapest exact challenge within the approved maximum", () => {
  const selected = selectHederaPaymentRequirement(2, [
    requirement({ amount: "4000000" }),
    requirement({ amount: "2000000" }),
  ], authorization);
  assert.equal(selected.amount, "2000000");
});

test("Hedera x402 rejects a challenge if any payment binding is outside policy", () => {
  for (const changed of [
    { network: "hedera:mainnet" },
    { asset: "0.0.0" },
    { payTo: "0.0.9999" },
    { amount: "5000001" },
    { extra: { feePayer: "0.0.5002" } },
    { scheme: "upto" },
  ]) {
    assert.throws(
      () => selectHederaPaymentRequirement(2, [requirement(changed)], authorization),
      /X402_CHALLENGE_NOT_AUTHORIZED/,
    );
  }
});

test("Hedera x402 rejects legacy challenges without the approved v2 exact fields", () => {
  assert.throws(() => selectHederaPaymentRequirement(1, [requirement()], authorization), /X402_VERSION_NOT_APPROVED/);
});

test("paid-output request requires successful settlement evidence and binds the stable operation ID", async () => {
  let request: Request | undefined;
  const input = Buffer.from([1, 2, 3]);
  const session = paymentSession(async (input, init) => {
    request = new Request(input, init);
    return new Response("paid result", {
      status: 200,
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: true,
        network: authorization.network,
        transaction: "0.0.5001@1729000000.000000001",
        amount: "2000000",
      }) },
    });
  });
  const result = await requestPaidOutput({
    session,
    url: "https://provider.example/operations/op-1",
    operationId: "op-1",
    inputDigest: sha256(input),
    body: input,
  });
  assert.equal(result.settledAmount, 2_000_000n);
  assert.equal(result.providerReceipt, "0.0.5001@1729000000.000000001");
  assert.equal(request?.headers.get("idempotency-key"), "op-1");
  assert.equal(request?.headers.get("x-baton-input-digest"), sha256(input));
});

test("paid-output request rejects settlement evidence that disagrees with the signed amount", async () => {
  const input = Buffer.from([1]);
  const session = paymentSession(async () => new Response("paid", {
    status: 200,
    headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({
      success: true,
      network: authorization.network,
      transaction: "0.0.5001@1729000000.000000001",
      amount: "3000000",
    }) },
  }));
  await assert.rejects(requestPaidOutput({
    session,
    url: "https://provider.example/operations/op-1",
    operationId: "op-1",
    inputDigest: sha256(input),
    body: input,
  }), /X402_SETTLED_AMOUNT_MISMATCH/);
});

test("paid-output request rejects a body that does not match the stable input digest before fetching", async () => {
  let fetches = 0;
  const session = paymentSession(async () => { fetches += 1; return new Response("unused"); });
  await assert.rejects(requestPaidOutput({
    session,
    url: "https://provider.example/operations/op-1",
    operationId: "op-1",
    inputDigest: "0x" + "a".repeat(64),
    body: new Uint8Array([1]),
  }), /INPUT_DIGEST_MISMATCH/);
  assert.equal(fetches, 0);
});

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: authorization.network,
    asset: authorization.asset,
    amount: "3000000",
    payTo: authorization.payee,
    maxTimeoutSeconds: 60,
    extra: { feePayer: authorization.feePayer },
    ...overrides,
  };
}

function paymentSession(fetchWithPayment: typeof fetch): HederaPaymentSession {
  return { fetchWithPayment, authorization, selectedAmount: () => 2_000_000n };
}

function sha256(value: Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}
