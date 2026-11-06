import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayActionDomain, gatewayActionMessage, GATEWAY_ACTION_TYPES } from "./gatewayAction.js";
import { authorizeSignedGatewayAction } from "./gatewayActionAuth.js";
import { OperationLedger } from "../services/ledger/operationLedger.js";
import type { Hex, JobSnapshot } from "../protocol/v1.js";

const worker = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
const other = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const escrow = "0x5555555555555555555555555555555555555555";
const job = {
  chainJobId: `0x${"1".repeat(64)}`,
  chainTaskId: `0x${"2".repeat(64)}`,
  terms: { jobId: "job-local-1", task: { taskId: "task-local-1" } },
  servicePolicy: {
    providerId: "local-fixture",
    network: "hedera:testnet",
    payee: `0x${"0".repeat(40)}`,
    asset: "HBAR",
    budget: 10n,
    perRequestCap: 4n,
    approvedServices: ["batch-data-v1"],
    policyVersion: "service-policy.v2",
  },
} as unknown as JobSnapshot;
const action = "SERVICE_EXECUTE";
const payload = { operationId: "op-1", inputDigest: `0x${"a".repeat(64)}`, amount: "2" };

test("signed gateway actions bind the actor, action payload, and escrow deployment", async () => {
  const fixture = await createLedger();
  try {
    const now = Math.floor(Date.now() / 1000);
    const body = await signedBody({ nonce: `0x${"b".repeat(64)}`, expiry: now + 120 });
    await authorize(fixture.ledger, body, { nowSeconds: now });
    await assert.rejects(authorize(fixture.ledger, body, { nowSeconds: now }), /ACTION_NONCE_REPLAYED/);

    const wrongPayloadBody = await signedBody({ nonce: `0x${"c".repeat(64)}`, expiry: now + 120 });
    await assert.rejects(
      authorize(fixture.ledger, wrongPayloadBody, { payload: { ...payload, amount: "3" }, nowSeconds: now }),
      /ACTION_ACTOR_MISMATCH/,
    );

    const wrongActionBody = await signedBody({ nonce: `0x${"7".repeat(64)}`, expiry: now + 120, action: "SERVICE_RECONCILE" });
    await assert.rejects(authorize(fixture.ledger, wrongActionBody, { nowSeconds: now }), /ACTION_ACTOR_MISMATCH/);

    const wrongTaskBody = await signedBody({
      nonce: `0x${"8".repeat(64)}`,
      expiry: now + 120,
      job: { ...job, chainTaskId: `0x${"9".repeat(64)}` } as JobSnapshot,
    });
    await assert.rejects(authorize(fixture.ledger, wrongTaskBody, { nowSeconds: now }), /ACTION_ACTOR_MISMATCH/);

    const wrongDeploymentBody = await signedBody({ nonce: `0x${"d".repeat(64)}`, expiry: now + 120 });
    await assert.rejects(
      authorize(fixture.ledger, wrongDeploymentBody, { verifyingContract: "0x6666666666666666666666666666666666666666", nowSeconds: now }),
      /ACTION_ACTOR_MISMATCH/,
    );

    const wrongActorBody = await signedBody({ nonce: `0x${"e".repeat(64)}`, expiry: now + 120, signer: other });
    await assert.rejects(authorize(fixture.ledger, wrongActorBody, { nowSeconds: now }), /ACTION_ACTOR_MISMATCH/);
  } finally {
    fixture.ledger.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("signed gateway actions reject absent, expired, and overlong authorizations", async () => {
  const fixture = await createLedger();
  try {
    const now = Math.floor(Date.now() / 1000);
    await assert.rejects(authorize(fixture.ledger, {}, { nowSeconds: now }), /INVALID_AUTH_NONCE/);

    const nonce = `0x${"f".repeat(64)}`;
    await assert.rejects(
      authorize(fixture.ledger, { authNonce: nonce, authExpiry: now }, { nowSeconds: now }),
      /ACTION_SIGNATURE_EXPIRED/,
    );
    await assert.rejects(
      authorize(fixture.ledger, { authNonce: nonce, authExpiry: now + 301 }, { nowSeconds: now }),
      /ACTION_SIGNATURE_LIFETIME_TOO_LONG/,
    );
    await assert.rejects(
      authorize(fixture.ledger, { authNonce: nonce, authExpiry: now + 120 }, { nowSeconds: now }),
      /INVALID_AUTH_SIGNATURE/,
    );
  } finally {
    fixture.ledger.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function signedBody(input: {
  nonce: Hex;
  expiry: number;
  signer?: typeof worker;
  job?: JobSnapshot;
  action?: string;
}): Promise<Record<string, unknown>> {
  const actor = worker.address;
  const message = gatewayActionMessage({
    action: input.action ?? action,
    job: input.job ?? job,
    actor,
    epoch: 2,
    payload,
    nonce: input.nonce,
    expiry: input.expiry,
  });
  const signature = await (input.signer ?? worker).signTypedData({
    domain: gatewayActionDomain(11155111, escrow),
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message,
  });
  return { authNonce: input.nonce, authExpiry: input.expiry, authSignature: signature };
}

function authorize(
  ledger: OperationLedger,
  body: unknown,
  overrides: { verifyingContract?: string; payload?: unknown; nowSeconds?: number } = {},
): Promise<void> {
  return authorizeSignedGatewayAction({
    chainId: 11155111,
    verifyingContract: overrides.verifyingContract ?? escrow,
    nonceStore: ledger,
    body,
    job,
    actor: worker.address,
    epoch: 2,
    action,
    payload: overrides.payload ?? payload,
    nowSeconds: overrides.nowSeconds,
  });
}

async function createLedger(): Promise<{ root: string; ledger: OperationLedger }> {
  const root = await mkdtemp(join(tmpdir(), "baton-gateway-action-auth-"));
  return { root, ledger: new OperationLedger(join(root, "ledger.sqlite")) };
}
