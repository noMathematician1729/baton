import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayActionDomain, gatewayActionMessage, GATEWAY_ACTION_TYPES } from "./gatewayAction.js";
import { importInitialChainJob } from "./chainJobImporter.js";
import { JobStore } from "../domain/jobs/jobStore.js";
import { digest, serialise, type JobSnapshot } from "../protocol/v1.js";
import { OperationLedger } from "../services/ledger/operationLedger.js";

const buyer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
const escrow = "0x5555555555555555555555555555555555555555";

test("buyer-signed chain import creates one local job and budget and retries idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-chain-job-import-"));
  const jobs = new JobStore(join(root, "jobs.json"));
  const ledger = new OperationLedger(join(root, "ledger.sqlite"));
  let authorityReads = 0;
  try {
    const snapshot = createSnapshot();
    const input = {
      snapshot: serialise(snapshot),
      authorizationBody: undefined as unknown,
      chainId: 11155111,
      verifyingContract: escrow,
      nonceStore: ledger,
      jobs,
      ledger,
      authority: {
        async assertImportableJob(job: JobSnapshot) {
          authorityReads += 1;
          assert.equal(digest(job), digest(snapshot));
        },
      },
    };
    input.authorizationBody = await signedBody(snapshot, "0x" + "a".repeat(64));

    const first = await importInitialChainJob(input);
    assert.equal(first.created, true);
    assert.equal(first.job.terms.jobId, snapshot.terms.jobId);
    assert.deepEqual(await ledger.getBalance(snapshot.terms.jobId), {
      deposits: 5n,
      available: 5n,
      reserved: 0n,
      settledSpend: 0n,
      returnedFunds: 0n,
    });

    input.authorizationBody = await signedBody(snapshot, "0x" + "b".repeat(64));
    const second = await importInitialChainJob(input);
    assert.equal(second.created, false);
    assert.equal(authorityReads, 1);
    assert.deepEqual(await ledger.pendingJobProvisions(), []);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("chain import rejects address-only input before authority reads or persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-chain-job-import-denied-"));
  const jobs = new JobStore(join(root, "jobs.json"));
  const ledger = new OperationLedger(join(root, "ledger.sqlite"));
  let authorityReads = 0;
  try {
    const snapshot = createSnapshot();
    await assert.rejects(importInitialChainJob({
      snapshot: serialise(snapshot),
      authorizationBody: { snapshot: serialise(snapshot) },
      chainId: 11155111,
      verifyingContract: escrow,
      nonceStore: ledger,
      jobs,
      ledger,
      authority: { async assertImportableJob() { authorityReads += 1; } },
    }), /INVALID_AUTH_NONCE/);
    assert.equal(await jobs.get(snapshot.terms.jobId), undefined);
    assert.equal(await ledger.getBalance(snapshot.terms.jobId), undefined);
    assert.equal(authorityReads, 0);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function signedBody(snapshot: JobSnapshot, nonce: `0x${string}`): Promise<Record<string, unknown>> {
  const expiry = Math.floor(Date.now() / 1000) + 120;
  const message = gatewayActionMessage({
    action: "IMPORT_JOB",
    job: snapshot,
    actor: buyer.address,
    epoch: 0,
    payload: { snapshotDigest: digest(snapshot) },
    nonce,
    expiry,
  });
  const authSignature = await buyer.signTypedData({
    domain: gatewayActionDomain(11155111, escrow),
    types: GATEWAY_ACTION_TYPES,
    primaryType: "GatewayAction",
    message,
  });
  return { snapshot: serialise(snapshot), authNonce: nonce, authExpiry: expiry, authSignature };
}

function createSnapshot(): JobSnapshot {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = new JobStore("unused.json").prepareCreate({
    buyer: buyer.address,
    rewardToken: ("0x" + "2".repeat(40)) as `0x${string}`,
    verifier: ("0x" + "4".repeat(40)) as `0x${string}`,
    rewards: [3n, 4n],
    serviceBudget: 5n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 3n,
    cutoff: now + 600,
  });
  snapshot.chainJobId = ("0x" + "1".repeat(64)) as `0x${string}`;
  snapshot.chainTaskId = ("0x" + "3".repeat(64)) as `0x${string}`;
  return snapshot;
}
