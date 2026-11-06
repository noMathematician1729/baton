import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { encodePaymentResponseHeader } from "@x402/core/http";
import type { GatewayOperation } from "../../src/protocol/v1.js";
import type { ProviderPaymentRequest } from "../../src/services/gateway/gateway.js";
import { HederaPaidServiceHttpClient } from "./hederaPaidServiceHttpClient.js";
import type { HederaPaymentConfig } from "./hederaX402.js";

const payment: HederaPaymentConfig = {
  accountId: "0.0.5001",
  privateKey: "unused-by-test-session-factory",
  network: "hedera:testnet",
};

test("paid-service submit binds input and operation ID through the x402 client", async () => {
  const bytes = Buffer.from("input payload");
  let captured: { url: string; init?: RequestInit } | undefined;
  let selected: unknown;
  const client = new HederaPaidServiceHttpClient(config(), async (input, init) => {
    captured = { url: String(input), init };
    return new Response("paid output", {
      status: 200,
      headers: {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader({
          success: true,
          network: payment.network,
          transaction: "0.0.5001@1729000000.000000001",
          amount: "2000000",
        }),
      },
    });
  }, (_payment, authorization, fetchImpl) => {
    selected = authorization;
    return { fetchWithPayment: fetchImpl, authorization, selectedAmount: () => 2_000_000n };
  });

  const result = await client.submit(request(bytes));
  assert.equal(result.operationId, "op-1");
  assert.equal(result.settledAmount, 2_000_000n);
  assert.equal(Buffer.from(result.output).toString(), "paid output");
  assert.deepEqual(selected, {
    network: payment.network,
    asset: "0.0.0",
    payee: "0.0.1234",
    feePayer: payment.accountId,
    maxAmount: 5n,
  });
  assert.equal(captured?.url, "https://provider.example/submit");
  assert.equal(new Headers(captured?.init?.headers).get("idempotency-key"), "op-1");
  assert.equal(new Headers(captured?.init?.headers).get("x-baton-input-digest"), sha256(bytes));
  assert.equal(new Headers(captured?.init?.headers).get("authorization"), "Bearer service-token");
  assert.deepEqual(Buffer.from(captured?.init?.body as Uint8Array), bytes);
});

test("settlement lookup distinguishes a terminal no-payment result from an unknown result", async () => {
  let body: unknown = { status: "pending" };
  const client = new HederaPaidServiceHttpClient(config(), async () => Response.json(body));
  assert.deepEqual(await client.lookup(operation()), { status: "unknown" });

  body = { status: "not-settled" };
  assert.deepEqual(await client.lookup(operation()), { status: "not-settled" });

  body = {
    status: "settled",
    providerReceipt: "receipt-1",
    settledAmount: "2000000",
    outputDigest: sha256(Buffer.from("paid output")),
  };
  assert.deepEqual(await client.lookup(operation()), {
    status: "settled",
    providerReceipt: "receipt-1",
    settledAmount: 2_000_000n,
    outputDigest: sha256(Buffer.from("paid output")),
  });

  const unavailable = new HederaPaidServiceHttpClient(config(), async () => new Response("missing", { status: 404 }));
  assert.deepEqual(await unavailable.lookup(operation()), { status: "unknown" });
});

test("output retrieval requires the operation binding and enforces the configured size limit", async () => {
  const output = Buffer.from("persisted result");
  const client = new HederaPaidServiceHttpClient({ ...config(), maxOutputBytes: 64 }, async (input, init) => {
    assert.match(String(input), /\/operations\/op-1\/output$/);
    assert.equal(new Headers(init?.headers).get("x-baton-operation-id"), "op-1");
    return new Response(output, { headers: { "x-baton-operation-id": "op-1" } });
  });
  assert.deepEqual(Buffer.from(await client.retrieveOutput(operation())), output);

  const wrongOperation = new HederaPaidServiceHttpClient(config(), async () => new Response(output, {
    headers: { "x-baton-operation-id": "different-operation" },
  }));
  await assert.rejects(wrongOperation.retrieveOutput(operation()), /PAID_OUTPUT_OPERATION_BINDING_MISMATCH/);

  const tooLarge = new HederaPaidServiceHttpClient({ ...config(), maxOutputBytes: 2 }, async () => new Response(output, {
    headers: { "x-baton-operation-id": "op-1" },
  }));
  await assert.rejects(tooLarge.retrieveOutput(operation()), /PAID_OUTPUT_SIZE_LIMIT_EXCEEDED/);
});

test("paid-service URLs require TLS, operation templates, and bounded configuration", () => {
  assert.throws(() => new HederaPaidServiceHttpClient({
    ...config(), submitUrl: "http://provider.example/submit",
  }), /PAID_PROVIDER_TLS_REQUIRED/);
  assert.throws(() => new HederaPaidServiceHttpClient({
    ...config(), statusUrlTemplate: "https://provider.example/status",
  }), /PAID_PROVIDER_URL_TEMPLATE_INVALID/);
  assert.throws(() => new HederaPaidServiceHttpClient({
    ...config(), maxOutputBytes: 32 * 1024 * 1024 + 1,
  }), /PAID_OUTPUT_SIZE_LIMIT_INVALID/);
});

function config() {
  return {
    submitUrl: "https://provider.example/submit",
    statusUrlTemplate: "https://provider.example/operations/{operationId}",
    outputUrlTemplate: "https://provider.example/operations/{operationId}/output",
    payment,
    bearerToken: "service-token",
  };
}

function request(inputBytes: Uint8Array): ProviderPaymentRequest {
  return {
    operationId: "op-1",
    jobId: "job-1",
    taskId: "task-1",
    worker: `0x${"1".repeat(40)}`,
    epoch: 1,
    service: "batch-data-v1",
    inputDigest: sha256(inputBytes) as `0x${string}`,
    amount: 5n,
    asset: "0.0.0",
    providerId: "hedera-x402",
    network: "hedera:testnet",
    payee: "0.0.1234",
    policyVersion: "service-policy.v2",
    approvedPolicyHash: `0x${"3".repeat(64)}`,
    inputBytes,
  };
}

function operation(): GatewayOperation {
  const { inputBytes: _inputBytes, ...requestWithoutInput } = request(Buffer.from("input payload"));
  return {
    ...requestWithoutInput,
    requestFingerprint: `0x${"4".repeat(64)}`,
    state: "UNKNOWN",
    nonce: "test",
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
  };
}

function sha256(value: Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}
