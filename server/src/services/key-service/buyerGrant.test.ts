import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayActionDomain, gatewayActionMessage, GATEWAY_ACTION_TYPES } from "../../chain/gatewayAction.js";
import { JobStore } from "../../domain/jobs/jobStore.js";
import { digest, type Hex, type JobSnapshot } from "../../protocol/v1.js";
import { grantAcceptedCheckpointKey } from "./buyerGrant.js";

const buyer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
const other = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const workerB = "0x3333333333333333333333333333333333333333" as Hex;
const escrow = "0x5555555555555555555555555555555555555555" as Hex;
const keyId = "buyer-key-v1";
const checkpointDigest = digest("a");

test("accepted-checkpoint key grants require and consume a buyer signature", async () => {
  const job = createJob();
  const nonce = digest("b");
  const authorizationBody = await signGrant(job, nonce);
  const nonceStore = createNonceStore();
  const grants: Array<{ worker: string; manifestDigest: string; keyHex: string }> = [];

  await grantAcceptedCheckpointKey({
    job,
    request: grantRequest(job),
    keyHex: "0x" + "77".repeat(32),
    keyId,
    authorizationBody,
    chainId: 11155111,
    verifyingContract: escrow,
    nonceStore,
    writer: { grantKey: (request, keyHex) => grants.push({ worker: request.worker, manifestDigest: request.manifestDigest, keyHex }) },
  });
  assert.deepEqual(grants, [{ worker: workerB, manifestDigest: checkpointDigest, keyHex: "0x" + "77".repeat(32) }]);
  await assert.rejects(grantAcceptedCheckpointKey({
    job,
    request: grantRequest(job),
    keyHex: "0x" + "77".repeat(32),
    keyId,
    authorizationBody,
    chainId: 11155111,
    verifyingContract: escrow,
    nonceStore,
    writer: { grantKey: () => assert.fail("replayed authorization must not write a grant") },
  }), /ACTION_NONCE_REPLAYED/);
});

test("key-grant administration rejects a non-buyer signer and an unaccepted checkpoint", async () => {
  const job = createJob();
  const nonceStore = createNonceStore();
  let writes = 0;
  const writer = { grantKey: () => { writes += 1; } };
  const authorizationBody = await signGrant(job, digest("c"), other);

  await assert.rejects(grantAcceptedCheckpointKey({
    job,
    request: grantRequest(job),
    keyHex: "0x" + "77".repeat(32),
    keyId,
    authorizationBody,
    chainId: 11155111,
    verifyingContract: escrow,
    nonceStore,
    writer,
  }), /ACTION_ACTOR_MISMATCH/);
  await assert.rejects(grantAcceptedCheckpointKey({
    job,
    request: { ...grantRequest(job), manifestDigest: digest("d") },
    keyHex: "0x" + "77".repeat(32),
    keyId,
    authorizationBody: {},
    chainId: 11155111,
    verifyingContract: escrow,
    nonceStore,
    writer,
  }), /KEY_GRANT_CHECKPOINT_NOT_ACCEPTED/);
  assert.equal(writes, 0);
});

async function signGrant(job: JobSnapshot, nonce: Hex, signer = buyer) {
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const request = grantRequest(job);
  const payload = {
    jobId: job.terms.jobId,
    taskId: job.terms.task.taskId,
    manifestDigest: request.manifestDigest.toLowerCase(),
    keyId: request.keyId,
    worker: request.worker.toLowerCase(),
  };
  const message = gatewayActionMessage({
    action: "GRANT_CHECKPOINT_KEY",
    job,
    actor: buyer.address,
    epoch: job.task.epoch,
    payload,
    nonce,
    expiry,
  });
  const authSignature = await signer.signTypedData({
    domain: gatewayActionDomain(11155111, escrow),
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message,
  });
  return { authNonce: nonce, authExpiry: expiry, authSignature };
}

function grantRequest(job: JobSnapshot) {
  return {
    jobId: job.terms.jobId,
    taskId: job.terms.task.taskId,
    manifestDigest: checkpointDigest,
    keyId,
    worker: workerB,
  };
}

function createJob(): JobSnapshot {
  const job = new JobStore("unused.json").prepareCreate({
    buyer: buyer.address as Hex,
    rewardToken: "0x2222222222222222222222222222222222222222",
    verifier: "0x4444444444444444444444444444444444444444",
    rewards: [3n, 4n],
    serviceBudget: 5n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 3n,
  });
  job.chainJobId = digest("1");
  job.chainTaskId = digest("2");
  job.task.epoch = 1;
  job.task.assignedWorker = other.address as Hex;
  job.task.acceptedHead = {
    manifestDigest: checkpointDigest,
    manifestRef: "arkiv://accepted-checkpoint",
    artifactManifestDigest: digest("e"),
    schemaVersion: "checkpoint.v1",
    sequence: 1,
    previousAcceptedHead: null,
  };
  return job;
}

function createNonceStore() {
  const consumed = new Set<string>();
  return {
    async consumeAuthNonce(scope: string, nonce: Hex) {
      const key = `${scope}:${nonce.toLowerCase()}`;
      if (consumed.has(key)) throw new Error("ACTION_NONCE_REPLAYED");
      consumed.add(key);
    },
  };
}
