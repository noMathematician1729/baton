import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { SepoliaAuthorityReader } from "../../chain/sepoliaAuthority.js";
import { domain, TAKEOVER_TYPES, type TakeoverAck } from "../../chain/signing.js";
import type { SepoliaTakeoverWriter } from "../../chain/sepoliaTakeoverWriter.js";
import { JobStore } from "../../domain/jobs/jobStore.js";
import { digest, type Hex, type JobSnapshot } from "../../protocol/v1.js";
import { Gateway, LocalPaymentProvider } from "../gateway/gateway.js";
import { OperationLedger } from "../ledger/operationLedger.js";
import { BuyerTakeoverPolicy } from "./buyerTakeoverPolicy.js";

const workerA = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const workerB = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000003");
const escrow = "0x5555555555555555555555555555555555555555" as Hex;

test("buyer takeover policy requires a heartbeat and retries after restart", async () => {
  const fixture = await createFixture();
  let restartedLedger: OperationLedger | undefined;
  try {
    const policy = makePolicy(fixture);
    await policy.runOnce();
    assert.equal(fixture.writer.drainCalls, 0, "a missing heartbeat must not trigger takeover");

    await fixture.gateway.heartbeat({
      jobId: fixture.job.terms.jobId,
      taskId: fixture.job.task.taskId,
      worker: workerA.address as Hex,
      epoch: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await policy.runOnce();
    assert.equal(fixture.writer.drainCalls, 1);
    assert.equal((await fixture.ledger.getTaskControl(fixture.job.terms.jobId, fixture.job.task.taskId))?.state, "DRAINED");

    const drainedJob = (await fixture.jobs.get(fixture.job.terms.jobId))!;
    const ack = await makeAcknowledgement(drainedJob);
    await policy.acceptAcknowledgement(drainedJob, ack.ack, ack.signature);
    await assert.rejects(policy.runOnce(), /TAKEOVER_SUBMISSION_FAILED/);
    assert.equal((await fixture.jobs.get(fixture.job.terms.jobId))?.task.assignedWorker?.toLowerCase(), workerA.address.toLowerCase());
    assert.equal((await fixture.ledger.getTaskControl(fixture.job.terms.jobId, fixture.job.task.taskId))?.state, "DRAINED");
    assert(await fixture.ledger.getTakeoverAcknowledgement(fixture.job.terms.jobId, fixture.job.task.taskId, 1));

    fixture.ledger.close();
    const jobs = new JobStore(fixture.jobsPath);
    restartedLedger = new OperationLedger(fixture.ledgerPath);
    await jobs.init();
    await restartedLedger.init();
    const gateway = new Gateway(jobs, restartedLedger, new LocalPaymentProvider());
    const restartedPolicy = makePolicy({ ...fixture, jobs, ledger: restartedLedger, gateway });
    await restartedPolicy.runOnce();

    const resumed = (await jobs.get(fixture.job.terms.jobId))!;
    assert.equal(resumed.task.assignedWorker?.toLowerCase(), workerB.address.toLowerCase());
    assert.equal(resumed.task.epoch, 2);
    assert.equal(resumed.task.drained, false);
    assert.equal((await restartedLedger.getTaskControl(fixture.job.terms.jobId, fixture.job.task.taskId))?.state, "RUNNING");
    assert.equal(await restartedLedger.getTakeoverAcknowledgement(fixture.job.terms.jobId, fixture.job.task.taskId, 1), undefined);
    assert.equal(fixture.writer.takeoverCalls, 2);
  } finally {
    fixture.ledger.close();
    restartedLedger?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("acceptance winning before drain refreshes the exact head and requires B to re-acknowledge", async () => {
  const fixture = await createFixture({ failTakeoverOnce: false });
  try {
    const policy = makePolicy(fixture);
    await fixture.gateway.heartbeat({
      jobId: fixture.job.terms.jobId,
      taskId: fixture.job.task.taskId,
      worker: workerA.address as Hex,
      epoch: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fixture.chain.acceptedHead = digest("newer-accepted-head");
    fixture.chain.acceptedSequence = 1;
    fixture.chain.acceptedManifestRef = "arkiv://accepted/newer";
    fixture.chain.nextMilestone = 1;
    fixture.chain.totalCredited = 3n;

    await policy.runOnce();
    assert.equal(fixture.chain.drained, true, "the buyer must fence chain work before rejecting the stale local head");
    assert.equal(fixture.writer.takeoverCalls, 0, "a stale acknowledgement must never trigger takeover");
    assert.equal((await fixture.ledger.getTaskControl(fixture.job.terms.jobId, fixture.job.task.taskId))?.state, "DRAINED");

    const refreshed = (await fixture.jobs.get(fixture.job.terms.jobId))!;
    assert.equal(refreshed.task.acceptedHead.manifestDigest, fixture.chain.acceptedHead);
    assert.equal(refreshed.task.acceptedHead.manifestRef, fixture.chain.acceptedManifestRef);
    assert.equal(refreshed.task.acceptedHead.sequence, fixture.chain.acceptedSequence);
    assert.equal(refreshed.task.nextMilestone, fixture.chain.nextMilestone);
    assert.equal(refreshed.credits.reduce((total, credit) => total + credit.amount, 0n), fixture.chain.totalCredited);

    const staleAck = await makeAcknowledgement(fixture.job);
    await policy.acceptAcknowledgement(fixture.job, staleAck.ack, staleAck.signature);
    await policy.runOnce();
    assert.equal(await fixture.ledger.getTakeoverAcknowledgement(
      fixture.job.terms.jobId,
      fixture.job.task.taskId,
      1,
    ), undefined, "an acknowledgement for the superseded head must be discarded");
    assert.equal(fixture.writer.takeoverCalls, 0);

    const freshAck = await makeAcknowledgement(refreshed);
    await policy.acceptAcknowledgement(refreshed, freshAck.ack, freshAck.signature);
    await policy.runOnce();
    const resumed = (await fixture.jobs.get(fixture.job.terms.jobId))!;
    assert.equal(resumed.task.assignedWorker?.toLowerCase(), workerB.address.toLowerCase());
    assert.equal(resumed.task.epoch, 2);
    assert.equal(resumed.task.acceptedHead.manifestDigest, fixture.chain.acceptedHead);
    assert.equal(fixture.chain.drained, false);
    assert.equal(fixture.writer.takeoverCalls, 1);
  } finally {
    fixture.ledger.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(options: { failTakeoverOnce?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "baton-takeover-policy-"));
  const jobsPath = join(root, "jobs.json");
  const ledgerPath = join(root, "ledger.sqlite");
  const jobs = new JobStore(jobsPath);
  const ledger = new OperationLedger(ledgerPath);
  const job = await jobs.create({
    chainJobId: digest("chain-job"),
    chainTaskId: digest("chain-task"),
    buyer: ("0x" + "1".repeat(40)) as Hex,
    rewardToken: ("0x" + "2".repeat(40)) as Hex,
    verifier: ("0x" + "3".repeat(40)) as Hex,
    rewards: [3n, 4n],
    serviceBudget: 5n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 3n,
  });
  await ledger.configureBudget(job.terms.jobId, job.servicePolicy);
  await jobs.assign(job.terms.jobId, workerA.address as Hex);
  const assignedJob = (await jobs.get(job.terms.jobId))!;
  const chain = {
    assignedWorker: workerA.address as Hex,
    epoch: 1,
    acceptedHead: assignedJob.task.acceptedHead.manifestDigest,
    acceptedSequence: assignedJob.task.acceptedHead.sequence,
    acceptedManifestRef: assignedJob.task.acceptedHead.manifestRef,
    nextMilestone: assignedJob.task.nextMilestone,
    totalCredited: 0n,
    paused: false,
    drained: false,
    closed: false,
    expired: false,
    successorGranted: true,
  };
  let drainCalls = 0;
  let takeoverCalls = 0;
  let failTakeoverOnce = options.failTakeoverOnce ?? true;
  const writer = {
    get drainCalls() { return drainCalls; },
    get takeoverCalls() { return takeoverCalls; },
    async drainTask() {
      drainCalls += 1;
      chain.drained = true;
      return digest("drain-tx");
    },
    async takeover() {
      takeoverCalls += 1;
      if (failTakeoverOnce) {
        failTakeoverOnce = false;
        throw new Error("TAKEOVER_SUBMISSION_FAILED");
      }
      chain.assignedWorker = workerB.address as Hex;
      chain.epoch = 2;
      chain.drained = false;
      return digest("takeover-tx");
    },
  };
  const checkpointVerifier = {
    async verifyCandidate() {},
    async recoverAcceptedCheckpoint(input: {
      acceptedHead: Hex;
      acceptedSequence: number;
      acceptedManifestRef: string;
      job: JobSnapshot;
    }) {
      return {
        manifestDigest: input.acceptedHead,
        manifestRef: input.acceptedManifestRef,
        artifactManifestDigest: digest("recovered-artifacts"),
        schemaVersion: "checkpoint.v1",
        sequence: input.acceptedSequence,
        previousAcceptedHead: input.job.task.acceptedHead.manifestDigest === `0x${"0".repeat(64)}`
          ? null
          : input.job.task.acceptedHead.manifestDigest,
      };
    },
  };
  return {
    root,
    jobsPath,
    ledgerPath,
    jobs,
    ledger,
    job: assignedJob,
    gateway: new Gateway(jobs, ledger, new LocalPaymentProvider(), undefined, checkpointVerifier),
    chain,
    writer,
  };
}

function makePolicy(fixture: Awaited<ReturnType<typeof createFixture>> & {
  jobs: JobStore;
  ledger: OperationLedger;
  gateway: Gateway;
}) {
  const authority = {
    async readTakeoverState() { return { ...fixture.chain }; },
    async assertTaskDrained() {
      if (!fixture.chain.drained) throw new Error("ONCHAIN_TASK_NOT_DRAINED");
    },
    async assertPreapprovedSuccessor() {
      if (!fixture.chain.successorGranted || !fixture.chain.drained) throw new Error("SUCCESSOR_AUTHORITY_NOT_GRANTED");
    },
    async assertTakeoverConfirmed() {
      if (fixture.chain.assignedWorker.toLowerCase() !== workerB.address.toLowerCase() || fixture.chain.epoch !== 2) {
        throw new Error("ONCHAIN_TAKEOVER_NOT_CONFIRMED");
      }
    },
  } as unknown as SepoliaAuthorityReader;
  return new BuyerTakeoverPolicy({
    jobs: fixture.jobs,
    ledger: fixture.ledger,
    gateway: fixture.gateway,
    authority,
    writer: fixture.writer as unknown as SepoliaTakeoverWriter,
    workerA: workerA.address as Hex,
    successor: workerB.address as Hex,
    escrowAddress: escrow,
    chainId: 11155111,
    heartbeatTimeoutMs: 1,
    intervalMs: 1_000,
  });
}

async function makeAcknowledgement(job: Awaited<ReturnType<typeof createFixture>>["job"]): Promise<{
  ack: TakeoverAck;
  signature: Hex;
}> {
  const ack: TakeoverAck = {
    jobId: job.chainJobId!,
    taskId: job.chainTaskId!,
    termsHash: job.terms.termsHash,
    successor: workerB.address,
    epoch: BigInt(job.task.epoch),
    expectedHead: job.task.acceptedHead.manifestDigest,
    compatibilityReport: digest("compatible-worker-b"),
    servicePolicy: digest(job.servicePolicy),
    nonce: 1n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 120),
  };
  const signature = await workerB.signTypedData({
    domain: domain(11155111, escrow),
    types: TAKEOVER_TYPES,
    primaryType: "TakeoverAck",
    message: ack,
  });
  return { ack, signature };
}
