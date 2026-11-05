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
      paymentLedger: { backend: "sqlite", implementation: "pending" },
    });
  });

  return app;
}
