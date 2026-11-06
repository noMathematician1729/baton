import express from "express";
import type { Hex } from "viem";
import { CoreError, type CoreService } from "./coreService.js";
import type { WorkerRecord } from "./coreStore.js";

type Handler = (request: express.Request, response: express.Response) => Promise<unknown>;

/** Routes for connected worker runtimes and the two-worker core job lifecycle. */
export function createCoreRouter(core: CoreService): express.Router {
  const router = express.Router();
  const wrap = (handler: Handler) => (request: express.Request, response: express.Response) => {
    handler(request, response).then(
      (result) => {
        if (!response.headersSent) response.json(result ?? { ok: true });
      },
      (error: Error) => {
        const status = error instanceof CoreError ? error.status : 500;
        if (status === 500) console.error(`[core] ${request.method} ${request.path}: ${error.message}`);
        response.status(status).json({ error: error.message });
      },
    );
  };
  const buyer = (request: express.Request) => core.checkBuyerToken(request.header("x-baton-buyer-token") ?? undefined);
  const worker = (request: express.Request): Promise<WorkerRecord> => {
    const raw = (request as express.Request & { rawBody?: string }).rawBody ?? "";
    return core.authenticateWorker(request.headers, request.method, request.originalUrl, request.method === "GET" ? "" : raw);
  };
  const jobId = (request: express.Request) => {
    const value = String(request.params.jobId);
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new CoreError(400, "JOB_ID_INVALID");
    return value.toLowerCase() as Hex;
  };

  // Read models (buyer console / CLI).
  router.get("/core/workers", wrap(async (req) => {
    buyer(req);
    return { workers: await core.listWorkers() };
  }));
  router.get("/core/jobs", wrap(async (req) => {
    buyer(req);
    return { jobs: await core.listJobs() };
  }));
  router.get("/core/jobs/:jobId", wrap(async (req) => {
    buyer(req);
    return core.view(jobId(req));
  }));
  router.get("/core/jobs/:jobId/reconcile", wrap(async (req) => {
    buyer(req);
    return core.reconcile(jobId(req));
  }));

  // Buyer controls.
  router.post("/core/workers/:workerId/connect", wrap(async (req) => {
    buyer(req);
    return core.connectWorker(String(req.params.workerId));
  }));
  router.post("/core/workers/:workerId/stop", wrap(async (req) => {
    buyer(req);
    return core.stopWorker(String(req.params.workerId), req.body?.mode === "graceful" ? "graceful" : "kill");
  }));
  router.post("/core/jobs", wrap(async (req) => {
    buyer(req);
    const job = await core.submitJob({ rewards: req.body?.rewards, seed: req.body?.seed, workerId: req.body?.workerId });
    return { jobId: job.jobId, ensName: job.ens.name, assignedWorker: job.activeWorkerId, phase: job.phase };
  }));
  router.post("/core/jobs/:jobId/retry", wrap(async (req) => {
    buyer(req);
    void core.kick(jobId(req));
    return { status: "resuming" };
  }));
  router.post("/core/jobs/:jobId/milestones/:milestone/accept", wrap(async (req) => {
    buyer(req);
    return core.acceptMilestone(jobId(req), Number(req.params.milestone));
  }));
  router.post("/core/jobs/:jobId/takeover", wrap(async (req) => {
    buyer(req);
    return core.requestTakeover(jobId(req), req.body?.workerId);
  }));

  // Worker onboarding (wallet ownership is proven by signature).
  router.post("/workers/:workerId/challenge", wrap(async (req) => core.challenge(String(req.params.workerId))));
  router.post("/workers/:workerId/register", wrap(async (req) => core.register(String(req.params.workerId), req.body)));

  // Worker-signed endpoints.
  router.post("/workers/:workerId/events", wrap(async (req) => {
    const w = await worker(req);
    if (w.workerId !== req.params.workerId) throw new CoreError(403, "WORKER_MISMATCH");
    await core.workerEvent(w, String(req.body?.state ?? "event"), req.body?.detail ?? {});
    return { ok: true };
  }));
  router.post("/workers/:workerId/smoke", wrap(async (req) => {
    const w = await worker(req);
    if (w.workerId !== req.params.workerId) throw new CoreError(403, "WORKER_MISMATCH");
    await core.smokeResult(w, req.body ?? {});
    return { ok: true };
  }));
  router.post("/workers/:workerId/heartbeat", wrap(async (req) => {
    const w = await worker(req);
    if (w.workerId !== req.params.workerId) throw new CoreError(403, "WORKER_MISMATCH");
    return core.heartbeat(w);
  }));
  router.get("/core/jobs/:jobId/worker-context", wrap(async (req) => core.workerContext(await worker(req), jobId(req))));
  router.post("/core/jobs/:jobId/offers", wrap(async (req) => core.submitOffer(await worker(req), jobId(req), req.body)));
  router.post("/core/jobs/:jobId/takeover-ack", wrap(async (req) => core.takeoverAck(await worker(req), jobId(req), req.body)));
  return router;
}
