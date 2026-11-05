import cors from "cors";
import express from "express";
import helmet from "helmet";
import { isAbsolute, resolve } from "node:path";
import { env, SERVER_ROOT } from "./config/env.js";
import { JobStore } from "./domain/jobs/jobStore.js";
import { OperationLedger } from "./services/ledger/operationLedger.js";
import { Gateway, LocalPaymentProvider } from "./services/gateway/gateway.js";
import { serialise, type CheckpointHead, type Hex } from "./protocol/v1.js";

export function createServices() {
  const dataDirectory = isAbsolute(env.BATON_DATA_DIR) ? env.BATON_DATA_DIR : resolve(SERVER_ROOT, env.BATON_DATA_DIR);
  const ledgerPath = isAbsolute(env.PAYMENT_LEDGER_PATH)
    ? env.PAYMENT_LEDGER_PATH
    : resolve(SERVER_ROOT, env.PAYMENT_LEDGER_PATH);
  const jobs = new JobStore(resolve(dataDirectory, "jobs.json"));
  const ledger = new OperationLedger(ledgerPath);
  const gateway = new Gateway(jobs, ledger, new LocalPaymentProvider());
  return { jobs, ledger, gateway };
}

export function createApp(services = createServices()) {
  const app = express();
  const { jobs, ledger, gateway } = services;

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_ORIGIN }));
  app.use(express.json({ limit: "1mb" }));

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
        sepolia: Boolean(env.SEPOLIA_RPC_URL && env.BATON_ESCROW_ADDRESS),
        ens: Boolean(env.ENS_JOB_NAME && env.ENS_RESOLVER_ADDRESS),
        hederaX402: Boolean(env.HEDERA_ACCOUNT_ID && env.HEDERA_PRIVATE_KEY && env.X402_FACILITATOR_URL),
      },
      paymentLedger: { backend: "sqlite", implementation: "node:sqlite" },
      paymentProvider: "local-fixture",
    });
  });

  app.get("/api/protocol", (_request, response) => {
    response.json({
      protocol: "baton.protocol.v1",
      digest: "sha256",
      emptyHead: "0x" + "00".repeat(32),
      confirmationBlocks: env.CONFIRMATION_BLOCKS,
      networkMode: "local-fixture",
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
    const job = await jobs.create({
      buyer: address(body.buyer, fallbackAddress("1")),
      rewardToken: address(body.rewardToken, fallbackAddress("2")),
      verifier: address(body.verifier, fallbackAddress("3")),
      rewards: bigintArray(body.rewards, [3n, 3n, 4n]),
      serviceBudget: bigintValue(body.serviceBudget, 20n),
      serviceAsset: stringValue(body.serviceAsset, "HBAR"),
      approvedServices: stringArray(body.approvedServices, ["batch-data-v1"]),
      perRequestCap: bigintValue(body.perRequestCap, 5n),
      cutoff: body.cutoff === undefined ? undefined : Number(body.cutoff),
    });
    await ledger.configureBudget(job.terms.jobId, job.servicePolicy);
    response.status(201).json(serialise(job));
  });

  app.post("/api/jobs/:jobId/assign", async (request, response) => {
    const worker = address(request.body?.worker, fallbackAddress("a"));
    response.json(serialise(await jobs.assign(request.params.jobId, worker)));
  });

  app.post("/api/jobs/:jobId/checkpoints", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const newHead: CheckpointHead = {
      manifestDigest: digestValue(body.manifestDigest, "manifestDigest"),
      manifestRef: stringValue(body.manifestRef, "local://checkpoint/" + request.params.jobId + "/" + Date.now()),
      artifactManifestDigest: digestValue(body.artifactManifestDigest, "artifactManifestDigest"),
      schemaVersion: stringValue(body.schemaVersion, "checkpoint.v1"),
      sequence: Number(body.sequence ?? 1),
    };
    response.json(serialise(await jobs.acceptMilestone({
      jobId: request.params.jobId,
      worker: address(body.worker, fallbackAddress("a")),
      epoch: Number(body.epoch ?? 1),
      expectedHead: digestValue(body.expectedHead, "expectedHead"),
      newHead,
    })));
  });

  app.post("/api/jobs/:jobId/drain", async (request, response) => {
    response.json(serialise(await gateway.drain(request.params.jobId)));
  });

  app.post("/api/jobs/:jobId/takeover", async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    response.json(serialise(await jobs.takeover({
      jobId: request.params.jobId,
      successor: address(body.successor, fallbackAddress("b")),
      expectedHead: digestValue(body.expectedHead, "expectedHead"),
      expectedEpoch: Number(body.expectedEpoch),
      compatibilityReport: digestValue(body.compatibilityReport, "compatibilityReport"),
    })));
  });

  app.post("/api/jobs/:jobId/pause", async (request, response) => {
    response.json(serialise(await jobs.pause(request.params.jobId)));
  });

  app.post("/api/jobs/:jobId/resume", async (request, response) => {
    response.json(serialise(await gateway.resume(request.params.jobId)));
  });

  app.post("/api/jobs/:jobId/claim", async (request, response) => {
    const worker = address(request.body?.worker, fallbackAddress("a"));
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
    const operation = await gateway.execute({
      operationId: stringValue(body.operationId, "op_" + request.params.jobId + "_" + String(body.inputDigest ?? Date.now())),
      jobId: request.params.jobId,
      taskId: stringValue(body.taskId, job?.task.taskId ?? ""),
      worker: address(body.worker, fallbackAddress("a")),
      epoch: Number(body.epoch ?? 1),
      service: stringValue(body.service, "batch-data-v1"),
      inputDigest: digestValue(body.inputDigest, "inputDigest"),
      amount: bigintValue(body.amount, 1n),
      asset: stringValue(body.asset, "HBAR"),
    });
    response.json(serialise(operation));
  });

  app.post("/api/services/operations/:operationId/reconcile", async (request, response) => {
    response.json(serialise(await gateway.reconcile(request.params.operationId)));
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const status = message.startsWith("JOB_NOT_FOUND") || message.startsWith("OPERATION_NOT_FOUND") ? 404 : 409;
    response.status(status).json({ error: message });
  });

  return app;
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

function fallbackAddress(hexCharacter: string): Hex {
  return ("0x" + hexCharacter.repeat(40)) as Hex;
}

function digestValue(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(`INVALID_${label.toUpperCase()}`);
  return value.toLowerCase() as Hex;
}
