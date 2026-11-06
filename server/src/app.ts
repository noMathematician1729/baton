import cors from "cors";
import express from "express";
import helmet from "helmet";
import { isAbsolute, resolve } from "node:path";
import { env, SERVER_ROOT } from "./config/env.js";
import { JobStore } from "./domain/jobs/jobStore.js";
import { OperationLedger } from "./services/ledger/operationLedger.js";
import { Gateway, LocalPaymentProvider } from "./services/gateway/gateway.js";
import { SepoliaAuthorityReader } from "./chain/sepoliaAuthority.js";
import { authorizeSignedGatewayAction } from "./chain/gatewayActionAuth.js";
import { serialise, type CheckpointHead, type Hex, type JobSnapshot } from "./protocol/v1.js";

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
      escrowAddress: env.BATON_ESCROW_ADDRESS,
      adapterAddress: env.BATON_AUTHORITY_ADAPTER_ADDRESS,
      confirmationBlocks: env.CONFIRMATION_BLOCKS,
    })
    : undefined;
  const gateway = new Gateway(jobs, ledger, new LocalPaymentProvider(), authority);
  return { jobs, ledger, gateway };
}

export function createApp(services = createServices()) {
  const app = express();
  const { jobs, ledger, gateway } = services;
  const ready = recoverPendingJobProvisions(jobs, ledger);

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
    response.json({
      api: "ready",
      contentStore: "arkiv",
      configuration: {
        arkiv: Boolean(env.ARKIV_ACCESS_KEY && env.ARKIV_SIGNER_PRIVATE_KEY && env.CHECKPOINT_ENCRYPTION_KEY),
        sepolia: Boolean(env.SEPOLIA_RPC_URL && env.BATON_ESCROW_ADDRESS && env.BATON_AUTHORITY_ADAPTER_ADDRESS),
        ens: Boolean(env.ENS_JOB_NAME && env.ENS_RESOLVER_ADDRESS),
        hederaX402: Boolean(env.HEDERA_ACCOUNT_ID && env.HEDERA_PRIVATE_KEY && env.X402_FACILITATOR_URL),
      },
      paymentLedger: { backend: "sqlite", implementation: "node:sqlite" },
      paymentProvider: "local-fixture",
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

  const localFixtureOnly: express.RequestHandler = (_request, response, next) => {
    if (env.NODE_ENV === "production") {
      response.status(503).json({ error: "LOCAL_FIXTURE_DISABLED" });
      return;
    }
    next();
  };
  app.use("/api/jobs", localFixtureOnly);
  app.use("/api/services", localFixtureOnly);

  app.get("/api/jobs", async (_request, response) => {
    response.json(serialise(await jobs.list()));
  });

  app.get("/api/jobs/:jobId", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) return response.status(404).json({ error: "JOB_NOT_FOUND" });
    response.json(serialise({ job, operations: await ledger.listOperations(request.params.jobId), balance: await ledger.getBalance(request.params.jobId) }));
  });

  if (env.NODE_ENV !== "production") {
    app.post("/api/demo/reset", async (_request, response) => {
      await jobs.reset();
      await ledger.reset();
      response.status(204).end();
    });
  }

  app.post("/api/jobs", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (gateway.requiresChainAuthority) throw new Error("CHAIN_JOB_IMPORT_NOT_IMPLEMENTED");
    const chainJobId = optionalChainJobId(body.chainJobId);
    const chainTaskId = optionalChainJobId(body.chainTaskId);
    const termsHash = optionalChainJobId(body.termsHash);
    if (gateway.requiresChainAuthority && (!chainJobId || !chainTaskId || !termsHash)) throw new Error("CHAIN_JOB_BINDING_REQUIRED");
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
      paymentPayee: address(body.paymentPayee, fallbackAddress("0")),
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
    await authorizeGatewayAction({ gateway, ledger, body, job, actor: worker, epoch, action: "CHECKPOINT_CANDIDATE", payload: candidatePayload, prefix: "workerAuth" });
    await authorizeGatewayAction({ gateway, ledger, body, job, actor: job.terms.buyer, epoch, action: "MILESTONE_ACCEPT", payload: candidatePayload, prefix: "buyerAuth" });
    response.json(serialise(await gateway.acceptMilestone({
      jobId: request.params.jobId,
      taskId,
      worker,
      epoch,
      acceptanceSpecHash,
      expectedHead,
      newHead,
    })));
  });

  app.post("/api/jobs/:jobId/drain", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    await authorizeGatewayAction({ gateway, ledger, body: request.body ?? {}, job, actor: job.terms.buyer, epoch: job.task.epoch, action: "DRAIN_TASK", payload: {} });
    response.json(serialise(await gateway.drain(request.params.jobId)));
  });

  app.post("/api/jobs/:jobId/takeover", async (request, response) => {
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
    response.json(serialise(await jobs.pause(request.params.jobId)));
  });

  app.post("/api/jobs/:jobId/resume", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    await authorizeGatewayAction({ gateway, ledger, body: request.body ?? {}, job, actor: job.terms.buyer, epoch: job.task.epoch, action: "RESUME_JOB", payload: {} });
    response.json(serialise(await gateway.resume(request.params.jobId)));
  });

  app.post("/api/jobs/:jobId/claim", async (request, response) => {
    const job = await jobs.get(request.params.jobId);
    if (!job) throw new Error("JOB_NOT_FOUND");
    const body = (request.body ?? {}) as Record<string, unknown>;
    const worker = address(body.worker, fallbackAddress("a"));
    const epoch = body.epoch === undefined ? job.task.epoch : epochValue(body.epoch);
    await authorizeGatewayAction({ gateway, ledger, body, job, actor: worker, epoch, action: "CLAIM_REWARD", payload: { worker } });
    response.json(serialise(await jobs.claim(request.params.jobId, worker)));
  });

  app.get("/api/jobs/:jobId/services/operations", async (request, response) => {
    response.json(serialise(await ledger.listOperations(request.params.jobId)));
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
    };
    await authorizeGatewayAction({
      gateway,
      ledger,
      body,
      job,
      actor: paymentRequest.worker,
      epoch: paymentRequest.epoch,
      action: "SERVICE_EXECUTE",
      payload: { ...paymentRequest, amount: paymentRequest.amount.toString() },
    });
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
      : message.startsWith("CHAIN_AUTHORITY_UNAVAILABLE")
        ? 503
        : 409;
    response.status(status).json({ error: message });
  });

  return app;
}

export async function recoverPendingJobProvisions(jobs: JobStore, ledger: OperationLedger): Promise<void> {
  await jobs.init();
  await ledger.init();
  await finishPendingJobProvisions(jobs, ledger);
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

function requiredAddress(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value)) throw new Error(`INVALID_${label}_ADDRESS`);
  return value.toLowerCase() as Hex;
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
