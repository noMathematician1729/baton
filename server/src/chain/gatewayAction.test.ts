import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayActionDomain, gatewayActionMessage, GATEWAY_ACTION_TYPES, recoverGatewayActionActor } from "./gatewayAction.js";

const workerKey = "0x0000000000000000000000000000000000000000000000000000000000000001";
const worker = privateKeyToAccount(workerKey);
const escrow = "0x5555555555555555555555555555555555555555";

test("gateway action signature binds task, policy, payload, epoch, expiry and deployment", async () => {
  const job = {
    terms: { jobId: "job-local-1", task: { taskId: "task-local-1" } },
    servicePolicy: { asset: "HBAR", budget: 10n, perRequestCap: 4n, approvedServices: ["batch-data-v1"], policyVersion: "service-policy.v1" },
  } as never;
  const nonce = ("0x" + "a".repeat(64)) as `0x${string}`;
  const message = gatewayActionMessage({
    action: "SERVICE_EXECUTE",
    job,
    actor: worker.address,
    epoch: 2,
    payload: { operationId: "op-1", inputDigest: "0x" + "b".repeat(64), amount: "2" },
    nonce,
    expiry: 2_000_000_000,
  });
  const domain = gatewayActionDomain(11155111, escrow);
  const signature = await worker.signTypedData({
    domain,
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message,
  });
  assert.equal(await recoverGatewayActionActor({ chainId: 11155111, verifyingContract: escrow, message, signature }), worker.address);
  const wrongDeploymentSigner = await recoverGatewayActionActor({
    chainId: 11155111,
    verifyingContract: "0x6666666666666666666666666666666666666666",
    message,
    signature,
  });
  assert.notEqual(wrongDeploymentSigner.toLowerCase(), worker.address.toLowerCase());
});
