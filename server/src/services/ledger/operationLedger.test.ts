import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "../../protocol/v1.js";
import { OperationLedger, type ReserveRequest } from "./operationLedger.js";

const policy = {
  providerId: "local-fixture",
  network: "hedera:testnet",
  payee: ("0x" + "00".repeat(20)) as `0x${string}`,
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
    await ledger.transition("op-2", "OUTPUT_AVAILABLE", {
      outputDigest: "0x" + "1".repeat(64),
      outputRef: "arkiv://paid-output/op-2",
    });
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

test("settlement is an immutable one-time fact and output cannot bypass it", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-ledger-settlement-"));
  const ledger = new OperationLedger(join(root, "payment-ledger.sqlite"));
  try {
    const settlementPolicy = { ...policy, budget: 10n, perRequestCap: 10n };
    await ledger.configureBudget("job-1", settlementPolicy);
    await ledger.reserve(reserveRequest("op-paid", "nonce-paid", 3n, settlementPolicy));
    await ledger.reserve(reserveRequest("op-uncertain", "nonce-uncertain", 4n, settlementPolicy));
    await ledger.transition("op-paid", "SUBMITTED");
    await ledger.transition("op-paid", "SETTLED", { providerReceipt: "receipt-paid" });

    await assert.rejects(ledger.transition("op-paid", "UNKNOWN"), /INVALID_OPERATION_TRANSITION/);
    await assert.rejects(ledger.transition("op-paid", "SETTLED", { providerReceipt: "receipt-again" }), /INVALID_OPERATION_TRANSITION/);
    await assert.rejects(ledger.transition("op-paid", "FAILED", { failureCode: "contradiction" }), /INVALID_OPERATION_TRANSITION/);

    await ledger.transition("op-uncertain", "SUBMITTED");
    await ledger.transition("op-uncertain", "UNKNOWN");
    await assert.rejects(ledger.transition("op-uncertain", "SUBMITTED"), /INVALID_OPERATION_TRANSITION/);
    await assert.rejects(
      ledger.transition("op-uncertain", "OUTPUT_AVAILABLE", {
        outputDigest: "0x" + "2".repeat(64),
        outputRef: "arkiv://forged-output",
      }),
      /INVALID_OPERATION_TRANSITION/,
    );
    assert.deepEqual(await ledger.getBalance("job-1"), {
      deposits: 10n,
      available: 3n,
      reserved: 4n,
      settledSpend: 3n,
      returnedFunds: 0n,
    });

    await ledger.transition("op-paid", "OUTPUT_AVAILABLE", {
      outputDigest: "0x" + "1".repeat(64),
      outputRef: "arkiv://paid-output/op-paid",
    });
    assert.deepEqual(await ledger.getBalance("job-1"), {
      deposits: 10n,
      available: 3n,
      reserved: 4n,
      settledSpend: 3n,
      returnedFunds: 0n,
    });
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
    const concurrencyPolicy = { ...policy, perRequestCap: 10n };
    await first.configureBudget("job-1", concurrencyPolicy);
    const results = await Promise.allSettled([
      first.reserve(reserveRequest("op-a", "nonce-a", 6n, concurrencyPolicy)),
      second.reserve(reserveRequest("op-b", "nonce-b", 6n, concurrencyPolicy)),
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

test("signed-action nonces remain consumed across SQLite restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-ledger-auth-"));
  const filePath = join(root, "payment-ledger.sqlite");
  const nonce = ("0x" + "a".repeat(64)) as `0x${string}`;
  let ledger = new OperationLedger(filePath);
  try {
    await ledger.consumeAuthNonce("sepolia:job-1:worker-a", nonce, Math.floor(Date.now() / 1000) + 60);
    ledger.close();
    ledger = new OperationLedger(filePath);
    await assert.rejects(
      ledger.consumeAuthNonce("sepolia:job-1:worker-a", nonce, Math.floor(Date.now() / 1000) + 60),
      /ACTION_NONCE_REPLAYED/,
    );
  } finally {
    ledger.close();
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

test("stable operation identity binds provider, network, payee, and the approved policy hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-ledger-payment-context-"));
  const ledger = new OperationLedger(join(root, "payment-ledger.sqlite"));
  try {
    await ledger.configureBudget("job-1", policy);
    const request = reserveRequest("op-context", "nonce-context", 2n);
    await ledger.reserve(request);

    await assert.rejects(
      ledger.reserve({ ...request, network: "hedera:mainnet", nonce: "nonce-wrong-network" }),
      /PAYMENT_POLICY_CONTEXT_MISMATCH/,
    );
    await assert.rejects(
      ledger.reserve({ ...request, payee: ("0x" + "9".repeat(40)) as `0x${string}`, nonce: "nonce-wrong-payee" }),
      /PAYMENT_POLICY_CONTEXT_MISMATCH/,
    );
    await assert.rejects(
      ledger.configureBudget("job-1", { ...policy, providerId: "different-provider" }),
      /BUDGET_IMMUTABLE/,
    );
    assert.equal((await ledger.listOperations("job-1")).length, 1);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy worker-scoped fingerprints migrate to stable handoff fingerprints", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-ledger-migration-"));
  const ledger = new OperationLedger(join(root, "payment-ledger.sqlite"));
  try {
    await ledger.configureBudget("job-1", policy);
    const legacy = reserveRequest("op-legacy", "nonce-legacy", 2n);
    const legacyFingerprint = digest({
      operationId: legacy.operationId,
      jobId: legacy.jobId,
      taskId: legacy.taskId,
      worker: legacy.worker,
      epoch: legacy.epoch,
      service: legacy.service,
      inputDigest: legacy.inputDigest,
      amount: legacy.amount.toString(),
      asset: legacy.asset,
    });
    await ledger.reserve({ ...legacy, requestFingerprint: legacyFingerprint });

    const stableFingerprint = digest({
      jobId: legacy.jobId,
      taskId: legacy.taskId,
      providerId: legacy.providerId,
      network: legacy.network,
      service: legacy.service,
      inputDigest: legacy.inputDigest,
      amount: legacy.amount.toString(),
      asset: legacy.asset,
      payee: legacy.payee.toLowerCase(),
      policyVersion: legacy.policyVersion,
      approvedPolicyHash: legacy.approvedPolicyHash,
    });
    const reused = await ledger.reserve({
      ...legacy,
      worker: "0x" + "b".repeat(40),
      epoch: 2,
      requestFingerprint: stableFingerprint,
      nonce: "nonce-after-takeover",
    });

    assert.equal(reused.requestFingerprint, stableFingerprint);
    assert.equal(reused.worker, legacy.worker, "the original operation owner should remain in the audit record");
    assert.deepEqual(await ledger.getBalance("job-1"), {
      deposits: 10n,
      available: 8n,
      reserved: 2n,
      settledSpend: 0n,
      returnedFunds: 0n,
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

function reserveRequest(operationId: string, nonce: string, amount: bigint, requestPolicy = policy): ReserveRequest {
  const inputDigest = "0x" + "1".repeat(64) as `0x${string}`;
  const approvedPolicyHash = digest(requestPolicy);
  return {
    operationId,
    jobId: "job-1",
    taskId: "task-1",
    worker: "0x" + "a".repeat(40),
    epoch: 1,
    service: "batch-data-v1",
    inputDigest,
    requestFingerprint: inputDigest,
    providerId: requestPolicy.providerId,
    network: requestPolicy.network,
    payee: requestPolicy.payee,
    policyVersion: requestPolicy.policyVersion,
    approvedPolicyHash,
    amount,
    asset: "HBAR",
    nonce,
  };
}
