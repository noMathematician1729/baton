import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationLedger, type ReserveRequest } from "./operationLedger.js";

const policy = {
  asset: "HBAR",
  budget: 10n,
  perRequestCap: 5n,
  approvedServices: ["batch-data-v1"],
  policyVersion: "service-policy.v1",
};

test("SQLite ledger persists UNKNOWN reservations and conserves the budget on failure and settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-ledger-"));
  const filePath = join(root, "payment-ledger.sqlite");
  let ledger = new OperationLedger(filePath);
  try {
    await ledger.configureBudget("job-1", policy);
    const request = reserveRequest("op-1", "nonce-1", 4n);
    const reserved = await ledger.reserve(request);
    assert.equal(reserved.state, "RESERVED");
    assert.equal((await ledger.reserve({ ...request, nonce: "retry-nonce" })).state, "RESERVED");

    await ledger.transition("op-1", "SUBMITTED");
    await ledger.transition("op-1", "UNKNOWN", { failureCode: "timeout" });
    ledger.close();

    ledger = new OperationLedger(filePath);
    const recovered = await ledger.getOperation("op-1");
    const held = await ledger.getBalance("job-1");
    assert.equal(recovered?.state, "UNKNOWN");
    assert.deepEqual(held, { deposits: 10n, available: 6n, reserved: 4n, settledSpend: 0n, returnedFunds: 0n });

    await ledger.transition("op-1", "FAILED", { failureCode: "confirmed-not-settled" });
    const released = await ledger.getBalance("job-1");
    assert.deepEqual(released, { deposits: 10n, available: 10n, reserved: 0n, settledSpend: 0n, returnedFunds: 0n });

    await ledger.reserve(reserveRequest("op-2", "nonce-2", 3n));
    await ledger.transition("op-2", "SUBMITTED");
    await ledger.transition("op-2", "SETTLED", { providerReceipt: "receipt-2" });
    await ledger.transition("op-2", "OUTPUT_AVAILABLE", { outputDigest: "0x" + "1".repeat(64) });
    assert.deepEqual(await ledger.getBalance("job-1"), {
      deposits: 10n,
      available: 7n,
      reserved: 0n,
      settledSpend: 3n,
      returnedFunds: 0n,
    });
    assert.equal((await ledger.listOperations("job-1")).length, 2);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite transaction prevents concurrent reservations from exceeding the budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-ledger-race-"));
  const filePath = join(root, "payment-ledger.sqlite");
  const first = new OperationLedger(filePath);
  const second = new OperationLedger(filePath);
  try {
    await first.configureBudget("job-1", { ...policy, perRequestCap: 10n });
    const results = await Promise.allSettled([
      first.reserve(reserveRequest("op-a", "nonce-a", 6n)),
      second.reserve(reserveRequest("op-b", "nonce-b", 6n)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status === "rejected") assert.match(String(rejected.reason), /BUDGET_EXHAUSTED/);
    assert.deepEqual(await first.getBalance("job-1"), {
      deposits: 10n,
      available: 4n,
      reserved: 6n,
      settledSpend: 0n,
      returnedFunds: 0n,
    });
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("operation IDs reject different request fingerprints and budgets stay immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-ledger-keys-"));
  const ledger = new OperationLedger(join(root, "payment-ledger.sqlite"));
  try {
    await ledger.configureBudget("job-1", policy);
    const request = reserveRequest("op-1", "nonce-1", 1n);
    await ledger.reserve(request);
    await assert.rejects(
      ledger.reserve({ ...request, requestFingerprint: "0x" + "f".repeat(64), nonce: "nonce-2" }),
      /OPERATION_KEY_REUSED/,
    );
    await assert.rejects(ledger.configureBudget("job-1", { ...policy, perRequestCap: 4n }), /BUDGET_IMMUTABLE/);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

function reserveRequest(operationId: string, nonce: string, amount: bigint): ReserveRequest {
  const digest = "0x" + "1".repeat(64) as `0x${string}`;
  return {
    operationId,
    jobId: "job-1",
    taskId: "task-1",
    worker: "0x" + "a".repeat(40),
    epoch: 1,
    service: "batch-data-v1",
    inputDigest: digest,
    requestFingerprint: digest,
    amount,
    asset: "HBAR",
    nonce,
  };
}
