import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Express } from "express";
import { privateKeyToAccount } from "viem/accounts";
import { gatewayActionDomain, gatewayActionMessage, GATEWAY_ACTION_TYPES } from "./chain/gatewayAction.js";
import { parseInitialChainJobSnapshot } from "./chain/chainJobImport.js";
import type { JobAuthorityReader } from "./chain/sepoliaAuthority.js";
import { JobStore } from "./domain/jobs/jobStore.js";
import { digest, serialise, type Hex, type JobSnapshot } from "./protocol/v1.js";
import { Gateway, LocalPaymentProvider } from "./services/gateway/gateway.js";
import { OperationLedger } from "./services/ledger/operationLedger.js";

const buyer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
const worker = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const escrow = "0x5555555555555555555555555555555555555555" as Hex;
const adapter = "0x6666666666666666666666666666666666666666" as Hex;

process.env.NODE_ENV = "production";
process.env.GATEWAY_AUTHORITY_MODE = "sepolia";
process.env.SEPOLIA_CHAIN_ID = "11155111";
process.env.SEPOLIA_RPC_URL = "https://rpc.example.invalid";
process.env.BATON_ESCROW_ADDRESS = escrow;
process.env.BATON_AUTHORITY_ADAPTER_ADDRESS = adapter;

const [{ createApp }, { env }] = await Promise.all([
  import("./app.js"),
  import("./config/env.js"),
]);

test("production API permits only buyer-signed initial chain-job import", async () => {
  const fixture = await createFixture();
  try {
    const snapshot = makeSnapshot(fixture.jobs);
    assert.deepEqual(parseInitialChainJobSnapshot(serialise(snapshot)), snapshot);

    const fixtureCreate = await dispatch(fixture.app, "POST", "/api/jobs", {});
    assert.equal(fixtureCreate.statusCode, 503);
    assert.equal(fixtureCreate.body.error, "LOCAL_FIXTURE_DISABLED");

    const unsignedImport = await dispatch(fixture.app, "POST", "/api/jobs/import", { snapshot: serialise(snapshot) });
    assert.equal(unsignedImport.statusCode, 409);
    assert.equal(unsignedImport.body.error, "INVALID_AUTH_NONCE");
    assert.equal(fixture.importReads(), 0);
    assert.equal((await fixture.jobs.list()).length, 0);

    const signedImport = await signedImportBody(snapshot, "0x" + "a".repeat(64) as Hex);
    const created = await dispatch(fixture.app, "POST", "/api/jobs/import", signedImport);
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.terms.jobId, snapshot.terms.jobId);
    assert.equal(fixture.importReads(), 1);
    assert.equal((await fixture.ledger.getBalance(snapshot.terms.jobId))?.available, snapshot.terms.serviceBudget);

    const idempotentImport = await dispatch(
      fixture.app,
      "POST",
      "/api/jobs/import",
      await signedImportBody(snapshot, "0x" + "b".repeat(64) as Hex),
    );
    assert.equal(idempotentImport.statusCode, 200);
    assert.equal(fixture.importReads(), 1);
  } finally {
    fixture.ledger.close();
    env.NODE_ENV = "production";
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

test("chain-mode worker action route rejects unsigned claims before crediting", async () => {
  const fixture = await createFixture();
  const previousMode = env.NODE_ENV;
  try {
    const snapshot = makeSnapshot(fixture.jobs);
    await fixture.ledger.beginJobProvision(snapshot);
    await fixture.jobs.importInitial(snapshot);
    await fixture.ledger.completeJobProvision(snapshot);
    await fixture.jobs.assign(snapshot.terms.jobId, worker.address as Hex);

    // The production API deliberately leaves lifecycle routes disabled until their full live wiring is ready.
    // Exercise signed-action dispatch in the configured chain-mode application context.
    env.NODE_ENV = "test";
    const response = await dispatch(fixture.app, "POST", `/api/jobs/${snapshot.terms.jobId}/claim`, {
      worker: worker.address,
      epoch: 1,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error, "INVALID_AUTH_NONCE");
    assert.equal((await fixture.jobs.get(snapshot.terms.jobId))?.credits.length, 0);
  } finally {
    fixture.ledger.close();
    env.NODE_ENV = previousMode;
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "baton-api-routes-"));
  const jobs = new JobStore(join(root, "jobs.json"));
  const ledger = new OperationLedger(join(root, "payment-ledger.sqlite"));
  await jobs.init();
  await ledger.init();
  let importReads = 0;
  const authority = {
    assertCurrentWorker: async () => undefined,
    assertAssignedWorker: async () => undefined,
    assertImportableJob: async () => { importReads += 1; },
  } as unknown as JobAuthorityReader;
  const gateway = new Gateway(jobs, ledger, new LocalPaymentProvider(), authority);
  const app = createApp({ jobs, ledger, gateway });
  return { root, jobs, ledger, app, importReads: () => importReads };
}

function makeSnapshot(jobs: JobStore): JobSnapshot {
  const snapshot = jobs.prepareCreate({
    chainJobId: ("0x" + "1".repeat(64)) as Hex,
    chainTaskId: ("0x" + "2".repeat(64)) as Hex,
    buyer: buyer.address as Hex,
    rewardToken: ("0x" + "3".repeat(40)) as Hex,
    verifier: ("0x" + "4".repeat(40)) as Hex,
    rewards: [3n, 4n],
    serviceBudget: 5n,
    serviceAsset: "HBAR",
    approvedServices: ["batch-data-v1"],
    perRequestCap: 3n,
  });
  return snapshot;
}

async function signedImportBody(snapshot: JobSnapshot, nonce: Hex): Promise<Record<string, unknown>> {
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

async function dispatch(app: Express, method: string, url: string, body: unknown): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
}> {
  const bytes = Buffer.from(JSON.stringify(body));
  const request = Object.assign(Readable.from([bytes]), {
    method,
    url,
    originalUrl: url,
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
    },
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    socket: { encrypted: false, remoteAddress: "127.0.0.1", remotePort: 1, localAddress: "127.0.0.1", localPort: 80 },
    connection: undefined,
  });
  request.connection = request.socket;

  const responseEvents = new EventEmitter();
  const headers = new Map<string, unknown>();
  const chunks: Buffer[] = [];
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    finished: false,
    writableEnded: false,
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    hasHeader(name: string) { return headers.has(name.toLowerCase()); },
    removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    write(chunk: string | Uint8Array) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk?: string | Uint8Array, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined));
      this.headersSent = true;
      this.finished = true;
      this.writableEnded = true;
      (typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
      responseEvents.emit("finish");
      return this;
    },
  });
  response.on = responseEvents.on.bind(responseEvents);
  response.once = responseEvents.once.bind(responseEvents);
  response.emit = responseEvents.emit.bind(responseEvents);

  return new Promise((resolve, reject) => {
    response.once("finish", () => {
      resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
    });
    try {
      app.handle(request as never, response as never, reject);
    } catch (error) {
      reject(error);
    }
  });
}
