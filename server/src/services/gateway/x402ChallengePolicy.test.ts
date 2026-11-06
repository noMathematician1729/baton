import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentRequirements } from "@x402/core/types";
import { createHederaChallengePolicy } from "./x402ChallengePolicy.js";

const config = {
  network: "hedera:testnet",
  asset: "0.0.429274",
  payTo: "0.0.7001",
  maxAmountAtomic: 25_000_000n,
  maxTimeoutSeconds: 300,
  feePayer: "0.0.8001",
} as const;

const valid: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.429274",
  amount: "25000000",
  payTo: "0.0.7001",
  maxTimeoutSeconds: 300,
  extra: { feePayer: "0.0.8001" },
};

const policy = createHederaChallengePolicy(config);

test("x402 v2 policy accepts an exact approved Hedera challenge", () => {
  assert.deepEqual(policy(2, [valid]), [valid]);
});

test("x402 challenge policy rejects unsupported protocol versions", () => {
  assert.deepEqual(policy(1, [valid]), []);
  assert.deepEqual(policy(3, [valid]), []);
});

for (const [label, patch] of [
  ["scheme", { scheme: "upto" }],
  ["network", { network: "hedera:mainnet" }],
  ["asset", { asset: "0.0.9999" }],
  ["payee", { payTo: "0.0.7002" }],
  ["fee payer", { extra: { feePayer: "0.0.8002" } }],
  ["missing fee payer", { extra: {} }],
  ["malformed amount", { amount: "1.5" }],
  ["zero amount", { amount: "0" }],
  ["over-cap amount", { amount: "25000001" }],
  ["excessive timeout", { maxTimeoutSeconds: 301 }],
  ["malformed timeout", { maxTimeoutSeconds: Number.NaN }],
] as const) {
  test(`x402 challenge policy rejects an unapproved ${label}`, () => {
    const candidate = { ...valid, ...patch } as PaymentRequirements;
    assert.deepEqual(policy(2, [candidate]), []);
  });
}

test("x402 challenge policy filters mixed offers and fails closed when none are acceptable", () => {
  const wrongPayee = { ...valid, payTo: "0.0.7002" };
  assert.deepEqual(policy(2, [wrongPayee, valid]), [valid]);
  assert.deepEqual(policy(2, [wrongPayee]), []);
});

test("x402 challenge policy rejects invalid configured caps and identities", () => {
  assert.throws(() => createHederaChallengePolicy({ ...config, maxAmountAtomic: 0n }), /AMOUNT_CAP_INVALID/);
  assert.throws(() => createHederaChallengePolicy({ ...config, maxTimeoutSeconds: Number.NaN }), /TIMEOUT_INVALID/);
  assert.throws(() => createHederaChallengePolicy({ ...config, feePayer: "" }), /IDENTITIES_REQUIRED/);
});
