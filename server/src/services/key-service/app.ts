import express from "express";
import type { CheckpointKeyGrantRequest } from "../../../packages/storage/src/recovery.js";
import { KeyServiceError, type CheckpointKeyGrantStore } from "./store.js";

export function createCheckpointKeyServiceApp(store: CheckpointKeyGrantStore) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb", strict: true }));
  app.get("/healthz", (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.status(200).json({ ok: true });
  });
  app.post("/v1/resolve", (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("pragma", "no-cache");
    const authorization = request.header("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(authorization);
    if (!match) {
      response.status(401).json({ error: "KEY_GRANT_UNAUTHORIZED" });
      return;
    }
    try {
      const grant = store.resolve(match[1]!, request.body as CheckpointKeyGrantRequest);
      response.status(200).json(grant);
    } catch (error) {
      if (error instanceof KeyServiceError) {
        const status = error.code === "UNAUTHORIZED" ? 401 : 403;
        response.status(status).json({ error: "KEY_GRANT_DENIED" });
        return;
      }
      response.status(400).json({ error: "KEY_GRANT_REQUEST_INVALID" });
    }
  });
  app.use((_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.status(404).json({ error: "NOT_FOUND" });
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.setHeader("cache-control", "no-store");
    response.status(400).json({ error: "KEY_GRANT_REQUEST_INVALID" });
  });
  return app;
}
