import cors from "cors";
import express from "express";
import helmet from "helmet";
import { isAbsolute, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { env, SERVER_ROOT } from "./config/env.js";
import { JobStore } from "./domain/jobs/jobStore.js";
import { OperationLedger } from "./services/ledger/operationLedger.js";
import { Gateway, LocalPaymentProvider, MAX_PROVIDER_INPUT_BYTES, type PaymentProvider } from "./services/gateway/gateway.js";
import { SepoliaAuthorityReader } from "./chain/sepoliaAuthority.js";
import { SepoliaTakeoverWriter } from "./chain/sepoliaTakeoverWriter.js";
import type { MilestoneOffer, TakeoverAck } from "./chain/signing.js";
import { authorizeSignedGatewayAction } from "./chain/gatewayActionAuth.js";
import { serialise, type CheckpointHead, type Hex, type JobSnapshot } from "./protocol/v1.js";
import { importInitialChainJob } from "./chain/chainJobImporter.js";
import { ArkivContentStore } from "../packages/storage/src/arkiv.js";
import { ArkivCheckpointCandidateVerifier, SUPPORTED_CHECKPOINT_ADAPTERS } from "./services/gateway/checkpointCandidateVerifier.js";
import { BuyerTakeoverPolicy } from "./services/takeover/buyerTakeoverPolicy.js";
import { ArkivRetentionMonitor } from "./services/retention/arkivRetentionMonitor.js";
import { ArkivPaidOutputStore } from "../services/provider/arkivPaidOutput.js";
import { HederaPaidServiceHttpClient } from "../services/provider/hederaPaidServiceHttpClient.js";
import { HederaX402PaymentProvider } from "../services/provider/hederaPaymentProvider.js";
import type { HederaPaymentConfig } from "../services/provider/hederaX402.js";

export type AppServices = {
  jobs: JobStore;
  ledger: OperationLedger;
  gateway: Gateway;
  ready?: Promise<void>;
  takeoverWriter?: SepoliaTakeoverWriter;
  takeoverPolicy?: BuyerTakeoverPolicy;
  retentionMonitor?: ArkivRetentionMonitor;
  authority?: SepoliaAuthorityReader;
};

export function createServices() {
  const dataDirectory = isAbsolute(env.BATON_DATA_DIR)
    ? env.BATON_DATA_DIR
    : resolve(SERVER_ROOT, env.BATON_DATA_DIR);
  const ledgerPath = isAbsolute(env.PAYMENT_LEDGER_PATH)
    ? env.PAYMENT_LEDGER_PATH
    : resolve(SERVER_ROOT, env.PAYMENT_LEDGER_PATH);
  const jobs = new JobStore(resolve(dataDirectory, "jobs.json"));
  const ledger = new OperationLedger(ledgerPath);
  const chainConfigured = Boolean(env.SEPOLIA_RPC_URL && env.BATON_ESCROW_ADDRESS && env.BATON_AUTHORITY_ADAPTER_ADDRESS);
  const useChainAuthority = env.GATEWAY_AUTHORITY_MODE === "sepolia"
    || (env.GATEWAY_AUTHORITY_MODE === "auto" && chainConfigured);
  if (useChainAuthority && !chainConfigured) throw new Error("CHAIN_AUTHORITY_CONFIG_INCOMPLETE");
  if (useChainAuthority && env.SEPOLIA_CHAIN_ID !== 11155111) throw new Error("CHAIN_NETWORK_MISMATCH");
  const authority = useChainAuthority
    ? new SepoliaAuthorityReader({
      rpcUrl: env.SEPOLIA_RPC_URL,
      backupRpcUrls: env.SEPOLIA_RPC_BACKUP_URLS.split(",").map((url) => url.trim()).filter(Boolean),
      escrowAddress: env.BATON_ESCROW_ADDRESS,
      adapterAddress: env.BATON_AUTHORITY_ADAPTER_ADDRESS,
      confirmationBlocks: env.CONFIRMATION_BLOCKS,
    })
    : undefined;
  const checkpointVerifier = useChainAuthority
    && env.ARKIV_ACCESS_KEY
    && env.ARKIV_SIGNER_PRIVATE_KEY
    && env.CHECKPOINT_ENCRYPTION_KEY
    ? createCheckpointCandidateVerifier()
    : undefined;
  const takeoverWriter = authority && env.SEPOLIA_DEPLOYER_PRIVATE_KEY
    ? new SepoliaTakeoverWriter({
      rpcUrl: env.SEPOLIA_RPC_URL,
      escrowAddress: env.BATON_ESCROW_ADDRESS,
      buyerPrivateKey: privateKeyValue(env.SEPOLIA_DEPLOYER_PRIVATE_KEY, "BUYER_TAKEOVER_SIGNER_INVALID"),
      confirmationBlocks: env.CONFIRMATION_BLOCKS,
    })
    : undefined;
  const gateway = new Gateway(jobs, ledger, createPaymentProvider(), authority, checkpointVerifier, takeoverWriter);
  if (env.TAKEOVER_POLICY_ENABLED && !authority) throw new Error("TAKEOVER_POLICY_REQUIRES_CHAIN_AUTHORITY");
  if (env.TAKEOVER_POLICY_ENABLED && !takeoverWriter) throw new Error("BUYER_TAKEOVER_SIGNER_REQUIRED");
  const takeoverPolicy = env.TAKEOVER_POLICY_ENABLED
    ? new BuyerTakeoverPolicy({
      jobs,
      ledger,
      gateway,
      authority: authority!,
      writer: takeoverWriter!,
      workerA: configuredAddress(env.WORKER_A_ADDRESS, "WORKER_A_ADDRESS_REQUIRED"),
      successor: configuredAddress(env.WORKER_B_ADDRESS, "WORKER_B_ADDRESS_REQUIRED"),
      escrowAddress: env.BATON_ESCROW_ADDRESS,
      chainId: env.SEPOLIA_CHAIN_ID,
      heartbeatTimeoutMs: env.WORKER_HEARTBEAT_TIMEOUT_MS,
      intervalMs: env.TAKEOVER_POLICY_INTERVAL_MS,
    })
    : undefined;
  const retentionMonitor = authority && checkpointVerifier
    ? new ArkivRetentionMonitor({
      jobs,
      authority,
      retainer: checkpointVerifier,
      onError: (jobId, error) => console.error(
        `[arkiv-retention] job ${jobId} renewal check blocked (${error instanceof Error ? error.message : "UNKNOWN_ERROR"})`,
      ),
    })
    : undefined;
  const ready = recoverPendingJobProvisions(jobs, ledger);
  return { jobs, ledger, gateway, authority, takeoverWriter, takeoverPolicy, retentionMonitor, ready };
}

export function createApp(services: AppServices = createServices()) {
  const app = express();
  const { jobs, ledger, gateway, takeoverPolicy, takeoverWriter, retentionMonitor, authority } = services;
  const ready = services.ready ?? recoverPendingJobProvisions(jobs, ledger);
  if (takeoverPolicy) void ready.then(() => takeoverPolicy.start(), (error) => {
    console.error(`[takeover-policy] startup blocked (${error instanceof Error ? error.message : "UNKNOWN_ERROR"})`);
  });
  if (retentionMonitor) void ready.then(() => retentionMonitor.start(), (error) => {
    console.error(`[arkiv-retention] startup blocked (${error instanceof Error ? error.message : "UNKNOWN_ERROR"})`);
  });

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_ORIGIN }));
  app.use(express.json({ limit: "1mb" }));
  app.use((_request, _response, next) => {
    void ready.then(() => next(), next);
  });

  app.get("/api/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "baton-api",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/status", (_request, response) => {
    const arkivConfigured = Boolean(env.ARKIV_ACCESS_KEY && env.ARKIV_SIGNER_PRIVATE_KEY && env.CHECKPOINT_ENCRYPTION_KEY);
    response.json({
      api: "ready",
      contentStore: arkivConfigured ? "arkiv" : "unconfigured",
      configuration: {
        arkiv: arkivConfigured,
        sepolia: Boolean(env.SEPOLIA_RPC_URL && env.BATON_ESCROW_ADDRESS && env.BATON_AUTHORITY_ADAPTER_ADDRESS),
        ens: Boolean(env.ENS_JOB_NAME && env.ENS_RESOLVER_ADDRESS),
        hederaX402: !gateway.usesLocalPaymentProvider,
      },
      paymentLedger: { backend: "sqlite", implementation: "node:sqlite" },
      paymentProvider: gateway.usesLocalPaymentProvider ? "local-fixture" : "hedera-x402",
      confirmedChainRead: gateway.lastConfirmedRead
        ? {
          blockNumber: gateway.lastConfirmedRead.blockNumber.toString(),
          blockHash: gateway.lastConfirmedRead.blockHash,
          confirmationBlocks: gateway.lastConfirmedRead.confirmationBlocks,
        }
        : null,
    });
  });

  app.get("/api/protocol", (_request, response) => {
    response.json({
      protocol: "baton.protocol.v1",
      digest: "sha256",
      emptyHead: "0x" + "00".repeat(32),
      confirmationBlocks: env.CONFIRMATION_BLOCKS,
      networkMode: gateway.requiresChainAuthority
        ? "testnet-configured"
        : "local-fixture",
    });
  });

  const localFixtureOnly: express.RequestHandler = (request, response, next) => {
    if (env.NODE_ENV !== "production"
      || (gateway.requiresChainAuthority && request.method === "POST"
        && /^\/operations\/[^/]+\/reconcile$/.test(request.path))) return next();
    response.status(503).json({ error: "LOCAL_FIXTURE_DISABLED" });
  };
  app.use("/api/jobs", (request, response, next) => {
    if (env.NODE_ENV !== "production") return next();
    if (gateway.requiresChainAuthority && request.method === "POST" && request.path === "/import") return next();
    if (gateway.requiresChainAuthority && request.method === "GET" && /^\/[^/]+$/.test(request.path)) return next();
    if (gateway.requiresChainAuthority && takeoverWriter && request.method === "POST"
      && /^\/[^/]+\/(assign|checkpoints|pause|resume)$/.test(request.path)) return next();
    if (gateway.requiresChainAuthority && request.method === "POST" && /^\/[^/]+\/claim$/.test(request.path)) return next();
    if (gateway.requiresChainAuthority && env.TAKEOVER_POLICY_ENABLED && request.method === "POST"
      && /^\/[^/]+\/(heartbeat|takeover-ack|drain|cancel-drain)$/.test(request.path)) return next();
    if (gateway.requiresChainAuthority && request.method === "POST"
      && /^\/[^/]+\/services\/(execute|operations\/list|operations\/[^/]+\/output)$/.test(request.path)) return next();
    response.status(503).json({ error: "LOCAL_FIXTURE_DISABLED" });
  });
  app.use("/api/services", localFixtureOnly);

  app.get("/api/jobs", async (_request, response) => {
    response.json(serialise(await jobs.list()));
  });

  app.get("/api/jobs/:jobId", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) return response.status(404).json({ error: "JOB_NOT_FOUND" });
    response.json(serialise({
      job,
      balance: await ledger.getBalance(request.params.jobId),
      gatewayControl: await ledger.getTaskControl(request.params.jobId, job.task.taskId),
    }));
  });

  if (env.NODE_ENV !== "production") {
    app.post("/api/demo/reset", async (_request, response) => {
      await jobs.reset();
      await ledger.reset();
      response.status(204).end();
    });
  }

  app.post("/api/jobs/import", async (request, response) => {
    if (!gateway.requiresChainAuthority) throw new Error("CHAIN_AUTHORITY_REQUIRED");
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = await importInitialChainJob({
      snapshot: body.snapshot,
      authorizationBody: body,
      chainId: env.SEPOLIA_CHAIN_ID,
      verifyingContract: env.BATON_ESCROW_ADDRESS,
      nonceStore: ledger,
      jobs,
      ledger,
      authority: { assertImportableJob: (job) => gateway.assertImportableJob(job) },
    });
    response.status(result.created ? 201 : 200).json(serialise(result.job));
  });

  app.post("/api/jobs", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (gateway.requiresChainAuthority) throw new Error("CHAIN_JOB_IMPORT_REQUIRED");
    const chainJobId = optionalChainJobId(body.chainJobId);
    const chainTaskId = optionalChainJobId(body.chainTaskId);
    const termsHash = optionalChainJobId(body.termsHash);
    const job = jobs.prepareCreate({
      chainJobId,
      chainTaskId,
      termsHash,
      buyer: address(body.buyer, fallbackAddress("1")),
      rewardToken: address(body.rewardToken, fallbackAddress("2")),
      verifier: address(body.verifier, fallbackAddress("3")),
      rewards: bigintArray(body.rewards, [3n, 3n, 4n]),
      serviceBudget: bigintValue(body.serviceBudget, 20n),
      serviceAsset: stringValue(body.serviceAsset, "HBAR"),
      approvedServices: stringArray(body.approvedServices, ["batch-data-v1"]),
      perRequestCap: bigintValue(body.perRequestCap, 5n),
      paymentProviderId: stringValue(body.paymentProviderId, "local-fixture"),
      paymentNetwork: stringValue(body.paymentNetwork, "hedera:testnet"),
      paymentPayee: paymentPayee(body.paymentPayee, fallbackAddress("0")),
      cutoff: body.cutoff === undefined ? undefined : Number(body.cutoff),
    });
    await ledger.beginJobProvision(job);
    try {
      await jobs.importInitial(job);
      await ledger.completeJobProvision(job);
    } catch (error) {
      try {
        await finishPendingJobProvisions(jobs, ledger);
        if (await jobs.get(job.terms.jobId) && await ledger.getBalance(job.terms.jobId)) {
          response.status(201).json(serialise(job));
          return;
        }
      } catch {
        // Leave the durable pending record for startup recovery.
      }
      throw error;
    }
    response.status(201).json(serialise(job));
  });

  app.post("/api/jobs/:jobId/assign", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const worker = requiredAddress(request.body?.worker, "WORKER");
    await authorizeGatewayAction({
      gateway,
      ledger,
      body: request.body ?? {},
      job,
      actor: job.terms.buyer,
      epoch: job.task.epoch,
      action: "ASSIGN_WORKER",
      payload: { worker },
    });
    response.json(serialise(await gateway.assign(request.params.jobId, worker)));
  });

  app.post("/api/jobs/:jobId/checkpoints", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const newHead: CheckpointHead = {
      manifestDigest: digestValue(body.manifestDigest, "manifestDigest"),
      manifestRef: stringValue(body.manifestRef, "local://checkpoint/" + request.params.jobId + "/" + Date.now()),
      artifactManifestDigest: digestValue(body.artifactManifestDigest, "artifactManifestDigest"),
      schemaVersion: stringValue(body.schemaVersion, "checkpoint.v1"),
      sequence: Number(body.sequence ?? 1),
      previousAcceptedHead: body.previousAcceptedHead === null
        ? null
        : digestValue(body.previousAcceptedHead, "previousAcceptedHead"),
    };
    const taskId = stringValue(body.taskId, "taskId");
    const worker = requiredAddress(body.worker, "WORKER");
    const epoch = epochValue(body.epoch);
    const acceptanceSpecHash = digestValue(body.acceptanceSpecHash, "acceptanceSpecHash");
    const expectedHead = digestValue(body.expectedHead, "expectedHead");
    const candidatePayload = { taskId, worker, epoch, acceptanceSpecHash, expectedHead, newHead };
    let offer: MilestoneOffer | undefined;
    let offerSignature: Hex | undefined;
    if (gateway.requiresChainAuthority) {
      if (!job.chainJobId || !job.chainTaskId) throw new Error("CHAIN_JOB_BINDING_REQUIRED");
      offer = {
        jobId: job.chainJobId,
        taskId: job.chainTaskId,
        termsHash: job.terms.termsHash,
        producer: worker,
        epoch: BigInt(epoch),
        milestone: job.task.nextMilestone,
        acceptanceSpecHash,
        expectedHead,
        newHead: newHead.manifestDigest,
        manifestRef: newHead.manifestRef,
        sequence: BigInt(newHead.sequence),
        nonce: uint256Value(body.offerNonce),
        expiry: BigInt(timestampValue(body.offerExpiry, "OFFER_EXPIRY")),
      };
      offerSignature = signatureValue(body.offerSignature, "OFFER_SIGNATURE");
    }
    const authorizedPayload = offer
      ? { ...candidatePayload, contractOffer: { ...offer, signature: offerSignature } }
      : candidatePayload;
    await authorizeGatewayAction({ gateway, ledger, body, job, actor: worker, epoch, action: "CHECKPOINT_CANDIDATE", payload: authorizedPayload, prefix: "workerAuth" });
    await authorizeGatewayAction({ gateway, ledger, body, job, actor: job.terms.buyer, epoch, action: "MILESTONE_ACCEPT", payload: authorizedPayload, prefix: "buyerAuth" });
    response.json(serialise(await gateway.acceptMilestone({
      jobId: request.params.jobId,
      taskId,
      worker,
      epoch,
      acceptanceSpecHash,
      expectedHead,
      newHead,
      offer,
      offerSignature,
    })));
  });

  app.post("/api/jobs/:jobId/heartbeat", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const heartbeat = {
      taskId: requiredString(body.taskId, "TASK_ID"),
      worker: requiredAddress(body.worker, "WORKER"),
      epoch: epochValue(body.epoch),
    };
    await authorizeGatewayAction({
      gateway,
      ledger,
      body,
      job,
      actor: heartbeat.worker,
      epoch: heartbeat.epoch,
      action: "WORKER_HEARTBEAT",
      payload: heartbeat,
    });
    response.json(serialise(await gateway.heartbeat({ jobId: request.params.jobId, ...heartbeat })));
  });

  app.post("/api/jobs/:jobId/drain", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    await authorizeGatewayAction({ gateway, ledger, body: request.body ?? {}, job, actor: job.terms.buyer, epoch: job.task.epoch, action: "DRAIN_TASK", payload: {} });
    const drained = await gateway.drain(request.params.jobId);
    if (gateway.requiresChainAuthority) {
      if (!takeoverWriter || !authority || !job.task.assignedWorker) throw new Error("BUYER_TAKEOVER_SIGNER_REQUIRED");
      const state = await authority.readTakeoverState(drained, job.task.assignedWorker);
      if (state.acceptedHead.toLowerCase() !== drained.task.acceptedHead.manifestDigest.toLowerCase()
        || state.acceptedSequence !== drained.task.acceptedHead.sequence
        || state.acceptedManifestRef !== drained.task.acceptedHead.manifestRef
        || state.assignedWorker.toLowerCase() !== job.task.assignedWorker.toLowerCase()
        || state.epoch !== job.task.epoch) throw new Error("ONCHAIN_TASK_STATE_MISMATCH");
      if (!state.drained) await takeoverWriter.drainTask(drained);
      await authority.assertTaskDrained(drained, job.task.assignedWorker);
    }
    response.json(serialise(drained));
  });

  app.post("/api/jobs/:jobId/takeover-ack", async (request, response) => {
    if (!takeoverPolicy) throw new Error("TAKEOVER_POLICY_DISABLED");
    const body = (request.body ?? {}) as Record<string, unknown>;
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const ack: TakeoverAck = {
      jobId: digestValue(body.jobId, "jobId"),
      taskId: digestValue(body.taskId, "taskId"),
      termsHash: digestValue(body.termsHash, "termsHash"),
      successor: requiredAddress(body.successor, "SUCCESSOR"),
      epoch: BigInt(epochValue(body.epoch)),
      expectedHead: digestValue(body.expectedHead, "expectedHead"),
      compatibilityReport: digestValue(body.compatibilityReport, "compatibilityReport"),
      servicePolicy: digestValue(body.servicePolicy, "servicePolicy"),
      nonce: uint256Value(body.nonce),
      expiry: BigInt(timestampValue(body.expiry, "EXPIRY")),
    };
    const signature = signatureValue(body.signature, "SIGNATURE");
    await takeoverPolicy.acceptAcknowledgement(job, ack, signature);
    response.status(202).json({ accepted: true, expiresAt: Number(ack.expiry) });
  });

  app.post("/api/jobs/:jobId/takeover", async (request, response) => {
    if (gateway.requiresChainAuthority) throw new Error("TAKEOVER_POLICY_RUNNER_REQUIRED");
    const body = (request.body ?? {}) as Record<string, unknown>;
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const successor = requiredAddress(body.successor, "SUCCESSOR");
    const expectedHead = digestValue(body.expectedHead, "expectedHead");
    const expectedEpoch = epochValue(body.expectedEpoch);
    const compatibilityReport = digestValue(body.compatibilityReport, "compatibilityReport");
    await authorizeGatewayAction({
      gateway,
      ledger,
      body,
      job,
      actor: job.terms.buyer,
      epoch: expectedEpoch,
      action: "TAKEOVER_TASK",
      payload: { successor, expectedHead, expectedEpoch, compatibilityReport },
    });
    response.json(serialise(await gateway.takeover({
      jobId: request.params.jobId,
      successor,
      expectedHead,
      expectedEpoch,
      compatibilityReport,
    })));
  });

  app.post("/api/jobs/:jobId/pause", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    await authorizeGatewayAction({ gateway, ledger, body: request.body ?? {}, job, actor: job.terms.buyer, epoch: job.task.epoch, action: "PAUSE_JOB", payload: {} });
    response.json(serialise(await gateway.pause(request.params.jobId, gateway.requiresChainAuthority
      ? async (currentJob) => {
        if (!authority || !takeoverWriter || !currentJob.task.assignedWorker || !authority.assertPauseAllowed || !authority.assertTaskPaused) {
          throw new Error("ESCROW_LIFECYCLE_WRITER_UNAVAILABLE");
        }
        const alreadyPaused = await authority.assertPauseAllowed(currentJob, currentJob.task.assignedWorker);
        if (!alreadyPaused) await takeoverWriter.pause(currentJob);
        await authority.assertTaskPaused(currentJob, currentJob.task.assignedWorker);
      }
      : undefined)));
  });

  app.post("/api/jobs/:jobId/resume", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    await authorizeGatewayAction({ gateway, ledger, body: request.body ?? {}, job, actor: job.terms.buyer, epoch: job.task.epoch, action: "RESUME_JOB", payload: {} });
    if (gateway.requiresChainAuthority) {
      const worker = job.task.assignedWorker;
      if (!authority || !takeoverWriter || !worker || !authority.assertResumeAllowed || !authority.assertTaskResumed) {
        throw new Error("ESCROW_LIFECYCLE_WRITER_UNAVAILABLE");
      }
      const chainPaused = await authority.assertResumeAllowed(job, worker);
      if (chainPaused) await takeoverWriter.resume(job);
      await authority.assertTaskResumed(job, worker);
    }
    response.json(serialise(await gateway.resume(request.params.jobId)));
  });

  app.post("/api/jobs/:jobId/cancel-drain", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    await authorizeGatewayAction({
      gateway,
      ledger,
      body: request.body ?? {},
      job,
      actor: job.terms.buyer,
      epoch: job.task.epoch,
      action: "CANCEL_DRAIN",
      payload: {},
    });
    response.json(serialise(await gateway.cancelDrain(request.params.jobId, gateway.requiresChainAuthority
      ? async (currentJob) => {
        if (!authority || !takeoverWriter || !currentJob.task.assignedWorker) {
          throw new Error("BUYER_TAKEOVER_SIGNER_REQUIRED");
        }
        const chainDrained = await authority.assertCanCancelDrain(currentJob, currentJob.task.assignedWorker);
        if (chainDrained) {
          await takeoverWriter.cancelDrain(currentJob);
          await authority.assertDrainCancelled(currentJob, currentJob.task.assignedWorker);
        }
      }
      : undefined)));
  });

  app.post("/api/jobs/:jobId/claim", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const body = (request.body ?? {}) as Record<string, unknown>;
    const worker = requiredAddress(body.worker, "WORKER");
    if (gateway.requiresChainAuthority) {
      if (!authority?.confirmWorkerClaim) throw new Error("CLAIM_CONFIRMATION_UNAVAILABLE");
      const transactionHash = digestValue(body.transactionHash, "TRANSACTION_HASH");
      const accounting = await authority.confirmWorkerClaim(job, worker, transactionHash);
      response.json(serialise(await jobs.reconcileConfirmedClaim(
        request.params.jobId,
        worker,
        accounting.credits,
        accounting.withdrawnCredits,
      )));
      return;
    }
    const epoch = body.epoch === undefined ? job.task.epoch : epochValue(body.epoch);
    await authorizeGatewayAction({ gateway, ledger, body, job, actor: worker, epoch, action: "CLAIM_REWARD", payload: { worker } });
    response.json(serialise(await jobs.claim(request.params.jobId, worker)));
  });

  app.get("/api/jobs/:jobId/services/operations", async (request, response) => {
    if (env.NODE_ENV === "production") return response.status(503).json({ error: "SIGNED_OPERATION_LIST_REQUIRED" });
    response.json(serialise(await ledger.listOperations(request.params.jobId)));
  });

  app.post("/api/jobs/:jobId/services/operations/list", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const worker = requiredAddress(body.worker, "WORKER");
    const epoch = epochValue(body.epoch);
    const after = operationCursorValue(body.after);
    const limit = operationPageLimitValue(body.limit);
    await authorizeGatewayAction({
      gateway,
      ledger,
      body,
      job,
      actor: worker,
      epoch,
      action: "SERVICE_OPERATIONS_LIST",
      payload: { worker, epoch, after: after ?? null, limit },
    });
    response.json(serialise(await gateway.listReusableOperations({
      jobId: request.params.jobId,
      worker,
      epoch,
      after,
      limit,
    })));
  });

  app.post("/api/jobs/:jobId/services/operations/:operationId/output", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operation = await ledger.getOperation(request.params.operationId);
    if (!operation || operation.jobId !== request.params.jobId) throw new Error("OPERATION_NOT_FOUND");
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const worker = requiredAddress(body.worker, "WORKER");
    const epoch = epochValue(body.epoch);
    await authorizeGatewayAction({
      gateway,
      ledger,
      body,
      job,
      actor: worker,
      epoch,
      action: "SERVICE_OUTPUT_GET",
      payload: {
        operationId: operation.operationId,
        requestFingerprint: operation.requestFingerprint,
        worker,
        epoch,
      },
    });
    const paidOutput = await gateway.retrievePaidOutput({
      jobId: request.params.jobId,
      operationId: operation.operationId,
      worker,
      epoch,
    });
    response.set({
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-baton-operation-id": paidOutput.operationId,
      "x-baton-output-digest": paidOutput.outputDigest,
    }).status(200).send(Buffer.from(paidOutput.bytes));
  });

  app.post("/api/jobs/:jobId/services/quote", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    response.json(serialise(await gateway.quote(request.params.jobId, stringValue(body.service, "batch-data-v1"), bigintValue(body.amount, 1n))));
  });

  app.post("/api/jobs/:jobId/services/execute", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const paymentRequest = {
      operationId: stringValue(body.operationId, "op_" + request.params.jobId + "_" + String(body.inputDigest ?? Date.now())),
      jobId: request.params.jobId,
      taskId: stringValue(body.taskId, job.task.taskId),
      worker: requiredAddress(body.worker, "WORKER"),
      epoch: epochValue(body.epoch),
      service: stringValue(body.service, "batch-data-v1"),
      inputDigest: digestValue(body.inputDigest, "inputDigest"),
      amount: bigintValue(body.amount, 1n),
      asset: stringValue(body.asset, "HBAR"),
      inputBytes: optionalInputBytes(body.inputBase64),
    };
    const { inputBytes: _inputBytes, ...authorizedPaymentRequest } = paymentRequest;
    await authorizeGatewayAction({
      gateway,
      ledger,
      body,
      job,
      actor: paymentRequest.worker,
      epoch: paymentRequest.epoch,
      action: "SERVICE_EXECUTE",
      payload: { ...authorizedPaymentRequest, amount: paymentRequest.amount.toString() },
    });
    if (env.NODE_ENV === "production" && gateway.usesLocalPaymentProvider) {
      throw new Error("LIVE_PAYMENT_PROVIDER_REQUIRED");
    }
    const operation = await gateway.execute({
      ...paymentRequest,
    });
    response.json(serialise(operation));
  });

  app.post("/api/services/operations/:operationId/reconcile", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operation = await ledger.getOperation(request.params.operationId);
    if (!operation) throw new Error("OPERATION_NOT_FOUND");
    const job = await jobs.get(operation.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const worker = requiredAddress(body.worker, "WORKER");
    const epoch = epochValue(body.epoch);
    await authorizeGatewayAction({ gateway, ledger, body, job, actor: worker, epoch, action: "SERVICE_RECONCILE", payload: { operationId: operation.operationId, requestFingerprint: operation.requestFingerprint, worker, epoch } });
    response.json(serialise(await gateway.reconcile(request.params.operationId, worker, epoch)));
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const status = message.startsWith("JOB_NOT_FOUND") || message.startsWith("OPERATION_NOT_FOUND")
      ? 404
      : [
        "CHAIN_AUTHORITY_UNAVAILABLE",
        "CHAIN_CONFIRMATION_UNAVAILABLE",
        "CHAIN_BLOCK_HASH_UNAVAILABLE",
        "CHAIN_STATE_REORGED",
        "CHAIN_RPC_DISAGREEMENT",
        "CHAIN_NETWORK_MISMATCH",
        "LIVE_PAYMENT_PROVIDER_REQUIRED",
        "PAID_OUTPUT_RETRIEVAL_UNAVAILABLE",
      ].includes(message)
        ? 503
        : 409;
    response.status(status).json({ error: message });
  });

  return app;
}

function createPaymentProvider(): PaymentProvider {
  const required = [
    env.HEDERA_ACCOUNT_ID,
    env.HEDERA_PRIVATE_KEY,
    env.HEDERA_PAID_SERVICE_URL,
    env.HEDERA_PAID_STATUS_URL_TEMPLATE,
    env.HEDERA_PAID_OUTPUT_URL_TEMPLATE,
    env.ARKIV_ACCESS_KEY,
    env.ARKIV_SIGNER_PRIVATE_KEY,
    env.CHECKPOINT_ENCRYPTION_KEY,
  ];
  if (required.some((value) => !value)) return new LocalPaymentProvider();

  if (env.X402_NETWORK !== "hedera:testnet" && env.X402_NETWORK !== "hedera:mainnet") {
    throw new Error("X402_NETWORK_INVALID");
  }
  const arkivSignerKey = privateKeyValue(env.ARKIV_SIGNER_PRIVATE_KEY, "ARKIV_SIGNER_PRIVATE_KEY_INVALID");
  const store = new ArkivContentStore({
    accessKey: env.ARKIV_ACCESS_KEY,
    signerPrivateKey: arkivSignerKey,
    rpcUrl: env.ARKIV_RPC_URL || undefined,
    permissionlessExtension: false,
  });
  const outputs = new ArkivPaidOutputStore(
    store,
    { async resolve() { return env.CHECKPOINT_ENCRYPTION_KEY; } },
    privateKeyToAccount(arkivSignerKey).address,
  );
  const payment: HederaPaymentConfig = {
    accountId: env.HEDERA_ACCOUNT_ID,
    privateKey: env.HEDERA_PRIVATE_KEY,
    network: env.X402_NETWORK,
  };
  const service = new HederaPaidServiceHttpClient({
    submitUrl: env.HEDERA_PAID_SERVICE_URL,
    statusUrlTemplate: env.HEDERA_PAID_STATUS_URL_TEMPLATE,
    outputUrlTemplate: env.HEDERA_PAID_OUTPUT_URL_TEMPLATE,
    payment,
    bearerToken: env.HEDERA_PAID_SERVICE_TOKEN || undefined,
    timeoutMs: env.HEDERA_PAID_SERVICE_TIMEOUT_MS,
  });
  return new HederaX402PaymentProvider(service, outputs);
}

export async function recoverPendingJobProvisions(jobs: JobStore, ledger: OperationLedger): Promise<void> {
  await jobs.init();
  await ledger.init();
  await finishPendingJobProvisions(jobs, ledger);
}

function createCheckpointCandidateVerifier(): ArkivCheckpointCandidateVerifier {
  const signerKey = privateKeyValue(env.ARKIV_SIGNER_PRIVATE_KEY);
  const store = new ArkivContentStore({
    accessKey: env.ARKIV_ACCESS_KEY,
    signerPrivateKey: signerKey,
    rpcUrl: env.ARKIV_RPC_URL || undefined,
    permissionlessExtension: false,
  });
  const signerAddress = privateKeyToAccount(signerKey).address;
  return new ArkivCheckpointCandidateVerifier({
    store,
    checkpointKey: env.CHECKPOINT_ENCRYPTION_KEY,
    keyId: env.CHECKPOINT_KEY_ID,
    expectedStorageOwner: signerAddress,
    supportedAdapters: SUPPORTED_CHECKPOINT_ADAPTERS,
  });
}

function privateKeyValue(value: string, errorCode = "ARKIV_SIGNER_PRIVATE_KEY_INVALID"): Hex {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[\da-f]{64}$/i.test(normalized)) throw new Error(errorCode);
  return normalized as Hex;
}

function configuredAddress(value: string, errorCode: string): Hex {
  if (!/^0x[\da-f]{40}$/i.test(value)) throw new Error(errorCode);
  return value.toLowerCase() as Hex;
}

async function finishPendingJobProvisions(jobs: JobStore, ledger: OperationLedger): Promise<void> {
  for (const provision of await ledger.pendingJobProvisions()) {
    await jobs.importInitial(provision.job);
    await ledger.completeJobProvision(provision.job);
  }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function bigintValue(value: unknown, fallback: bigint): bigint {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new Error("INVALID_INTEGER");
  }
}

function bigintArray(value: unknown, fallback: bigint[]): bigint[] {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => bigintValue(item, 0n));
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function address(value: unknown, fallback: Hex): Hex {
  const candidate = typeof value === "string" && value.length > 0 ? value : fallback;
  if (!/^0x[0-9a-f]{40}$/i.test(candidate)) throw new Error("INVALID_ADDRESS");
  return candidate.toLowerCase() as Hex;
}

function paymentPayee(value: unknown, fallback: Hex): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (/^0x[0-9a-f]{40}$/i.test(value) || /^\d+\.\d+\.\d+$/.test(value)) return value.toLowerCase();
  throw new Error("INVALID_PAYMENT_PAYEE");
}

function requiredAddress(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value)) throw new Error(`INVALID_${label}_ADDRESS`);
  return value.toLowerCase() as Hex;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`INVALID_${label}`);
  return value;
}

function epochValue(value: unknown): number {
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("INVALID_EPOCH");
  return epoch;
}

function optionalChainJobId(value: unknown): Hex | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error("INVALID_CHAIN_JOB_ID");
  return value.toLowerCase() as Hex;
}

async function authorizeGatewayAction(input: {
  gateway: Gateway;
  ledger: OperationLedger;
  body: unknown;
  job: JobSnapshot;
  actor: Hex;
  epoch: number;
  action: string;
  payload: unknown;
  prefix?: string;
}): Promise<void> {
  if (!input.gateway.requiresChainAuthority) return;
  await authorizeSignedGatewayAction({
    chainId: env.SEPOLIA_CHAIN_ID,
    verifyingContract: env.BATON_ESCROW_ADDRESS,
    nonceStore: input.ledger,
    body: input.body,
    job: input.job,
    actor: input.actor,
    epoch: input.epoch,
    action: input.action,
    payload: input.payload,
    prefix: input.prefix,
  });
}

function fallbackAddress(hexCharacter: string): Hex {
  return ("0x" + hexCharacter.repeat(40)) as Hex;
}

function digestValue(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(`INVALID_${label.toUpperCase()}`);
  return value.toLowerCase() as Hex;
}

function signatureValue(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[\da-f]{130}$/i.test(value)) throw new Error(`INVALID_${label}`);
  return value as Hex;
}

function timestampValue(value: unknown, label: string): number {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error(`INVALID_${label}`);
  return timestamp;
}

function operationCursorValue(value: unknown): { createdAt: string; operationId: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_OPERATION_CURSOR");
  const cursor = value as Record<string, unknown>;
  if (typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))
    || typeof cursor.operationId !== "string" || cursor.operationId.length < 1 || cursor.operationId.length > 256) {
    throw new Error("INVALID_OPERATION_CURSOR");
  }
  return { createdAt: cursor.createdAt, operationId: cursor.operationId };
}

function operationPageLimitValue(value: unknown): number {
  if (value === undefined) return 50;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("OPERATION_PAGE_LIMIT_INVALID");
  return limit;
}

function optionalInputBytes(value: unknown): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0
    || value.length > Math.ceil(MAX_PROVIDER_INPUT_BYTES * 4 / 3)) throw new Error("PROVIDER_INPUT_INVALID");
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0 || decoded.byteLength > MAX_PROVIDER_INPUT_BYTES || decoded.toString("base64") !== value) {
    throw new Error("PROVIDER_INPUT_INVALID");
  }
  return Uint8Array.from(decoded);
}

function uint256Value(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("INVALID_NONCE");
  const nonce = BigInt(value);
  if (nonce >= 1n << 256n) throw new Error("INVALID_NONCE");
  return nonce;
}
