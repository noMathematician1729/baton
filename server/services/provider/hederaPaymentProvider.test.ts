import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { GatewayOperation } from "../../src/protocol/v1.js";
import type { ProviderPaymentRequest } from "../../src/services/gateway/gateway.js";
import { ArkivPaidOutputStore } from "./arkivPaidOutput.js";
import { HederaX402PaymentProvider, type HederaPaidServiceClient } from "./hederaPaymentProvider.js";

const output = Buffer.from("paid output");
const receipt = "0.0.5001@1729000000.000000001";

test("provider archives paid output and reports the actual debit after settlement", async () => {
  let archived: Uint8Array | undefined;
  const provider = new HederaX402PaymentProvider({
    async submit(request) {
      return { operationId: request.operationId, output, outputDigest: sha256(output), paymentResponse: "encoded", providerReceipt: receipt, settledAmount: 3n };
    },
    async lookup() { return { status: "unknown" }; },
    async retrieveOutput() { return output; },
  }, {
    async put(input) {
      archived = input.bytes;
      return { outputDigest: sha256(input.bytes), outputRef: "arkiv://paid-output/test" };
    },
  } as unknown as ArkivPaidOutputStore);

  const result = await provider.submit(request());
  assert.equal(result.providerReceipt, receipt);
  assert.equal(result.settledAmount, 3n);
  assert.equal(result.outputDigest, sha256(output));
  assert.equal(result.outputRef, "arkiv://paid-output/test");
  assert.deepEqual(archived, output);
});

test("provider requires bounded input bytes before it can authorize a new paid request", async () => {
  let submissions = 0;
  const provider = new HederaX402PaymentProvider({
    async submit() { submissions += 1; throw new Error("must not submit"); },
    async lookup() { return { status: "unknown" }; },
    async retrieveOutput() { return output; },
  }, {} as ArkivPaidOutputStore);
  const missing = request();
  delete missing.inputBytes;
  await assert.rejects(provider.submit(missing), /PROVIDER_INPUT_REQUIRED/);
  assert.equal(submissions, 0);
  await assert.rejects(provider.submit({ ...request(), inputBytes: new Uint8Array(256 * 1024 + 1) }), /PROVIDER_INPUT_SIZE_LIMIT_EXCEEDED/);
  assert.equal(submissions, 0);
});

test("provider reconciliation retrieves the previously settled output without resubmitting", async () => {
  let submissions = 0;
  let reads = 0;
  const service: HederaPaidServiceClient = {
    async submit() { submissions += 1; throw new Error("must not resubmit"); },
    async lookup() { return { status: "settled", providerReceipt: receipt, settledAmount: 2n, outputDigest: sha256(output) }; },
    async retrieveOutput() { reads += 1; return output; },
  };
  const provider = new HederaX402PaymentProvider(service, {
    async put(input) { return { outputDigest: sha256(input.bytes), outputRef: "arkiv://paid-output/recovered" }; },
  } as unknown as ArkivPaidOutputStore);

  assert.deepEqual(await provider.reconcile(operation()), {
    status: "settled",
    result: {
      providerReceipt: receipt,
      settledAmount: 2n,
      outputDigest: sha256(output),
      outputRef: "arkiv://paid-output/recovered",
    },
  });
  assert.equal(submissions, 0);
  assert.equal(reads, 1);
});

test("provider keeps unresolved status explicit and rejects a debit above its reservation", async () => {
  const pending = new HederaX402PaymentProvider({
    async submit() { throw new Error("unused"); },
    async lookup() { return { status: "unknown" }; },
    async retrieveOutput() { return output; },
  }, {} as ArkivPaidOutputStore);
  assert.deepEqual(await pending.reconcile(operation()), { status: "unknown" });

  const overspend = new HederaX402PaymentProvider({
    async submit(request) {
      return { operationId: request.operationId, output, outputDigest: sha256(output), paymentResponse: "encoded", providerReceipt: receipt, settledAmount: 6n };
    },
    async lookup() { return { status: "unknown" }; },
    async retrieveOutput() { return output; },
  }, {} as ArkivPaidOutputStore);
  await assert.rejects(overspend.submit(request()), /SETTLED_AMOUNT_OUT_OF_RANGE/);
});

function request(): ProviderPaymentRequest {
  const inputBytes = Buffer.from("paid input");
  return {
    operationId: "op-1",
    jobId: "job-1",
    taskId: "task-1",
    worker: "0x" + "1".repeat(40),
    epoch: 1,
    service: "batch-data-v1",
    inputDigest: sha256(inputBytes),
    amount: 5n,
    asset: "HBAR",
    providerId: "hedera-x402",
    network: "hedera:testnet",
    payee: "0.0.1234",
    policyVersion: "service-policy.v2",
    approvedPolicyHash: "0x" + "3".repeat(64),
    inputBytes,
  };
}

function operation(): GatewayOperation {
  const { inputBytes: _inputBytes, ...requestWithoutInput } = request();
  return {
    ...requestWithoutInput,
    requestFingerprint: "0x" + "4".repeat(64),
    state: "UNKNOWN",
    nonce: "test",
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
  };
}

function sha256(value: Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}
