import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Express } from "express";

process.env.NODE_ENV = "test";
process.env.GATEWAY_AUTHORITY_MODE = "local";

test("HTTP API uses and recovers the SQLite payment ledger across app restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "baton-api-"));
  const previousDataDirectory = process.env.BATON_DATA_DIR;
  const previousLedgerPath = process.env.PAYMENT_LEDGER_PATH;
  process.env.BATON_DATA_DIR = join(root, "data");
  process.env.PAYMENT_LEDGER_PATH = join(root, "payment-ledger.sqlite");
  const { createApp, createServices } = await import("./app.js");
  let services = createServices();

  try {
    await withServer(createApp(services), async (baseUrl) => {
      const health = await fetch(`${baseUrl}/api/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).status, "ok");

      const status = await fetch(`${baseUrl}/api/status`);
      const runtime = await status.json();
      assert.deepEqual(runtime.paymentLedger, { backend: "sqlite", implementation: "node:sqlite" });
      assert.equal(runtime.paymentProvider, "local-fixture");

      const createResponse = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          buyer: address("1"),
          rewardToken: address("2"),
          verifier: address("3"),
          rewards: [3],
          serviceBudget: 10,
          serviceAsset: "HBAR",
          approvedServices: ["batch-data-v1"],
          perRequestCap: 5,
        }),
      });
      assert.equal(createResponse.status, 201);
      const created = await createResponse.json();
      const jobId = created.terms.jobId as string;
      const taskId = created.terms.task.taskId as string;
      const worker = address("a");

      const assignResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker }),
      });
      assert.equal(assignResponse.status, 200);

      const operationResponse = await fetch(`${baseUrl}/api/jobs/${jobId}/services/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "api-operation-1",
          taskId,
          worker,
          epoch: 1,
          service: "batch-data-v1",
          inputDigest: "0x" + "4".repeat(64),
          amount: 2,
          asset: "HBAR",
        }),
      });
      assert.equal(operationResponse.status, 200);
      const operation = await operationResponse.json();
      assert.equal(operation.state, "OUTPUT_AVAILABLE");
      assert.equal(operation.providerReceipt, "local-hedera-receipt:api-operation-1");
    });

    services.ledger.close();
    services = createServices();
    await withServer(createApp(services), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/jobs`);
      assert.equal(response.status, 200);
      const [job] = await response.json();
      assert.equal(job.terms.jobId, (await services.jobs.list())[0]?.terms.jobId);

      const detailResponse = await fetch(`${baseUrl}/api/jobs/${job.terms.jobId}`);
      const details = await detailResponse.json();
      assert.equal(details.operations[0].state, "OUTPUT_AVAILABLE");
      assert.equal(details.balance.available, "8n");
      assert.equal(details.balance.settledSpend, "2n");
    });
  } finally {
    services.ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    restoreEnvironment("BATON_DATA_DIR", previousDataDirectory);
    restoreEnvironment("PAYMENT_LEDGER_PATH", previousLedgerPath);
  }
});

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addressInfo = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${addressInfo.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function address(digit: string): string {
  return "0x" + digit.repeat(40);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
