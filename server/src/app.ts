import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";

export function createApp() {
  const app = express();

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

  return app;
}
