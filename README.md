# BATON

BATON is a client/server monorepo for resumable work. The React + TypeScript client is the buyer console; the Node.js + TypeScript server contains the API, worker runtime, protocol, authority contracts, payment gateway and Arkiv adapters.

## Quick start

Requirements: Node.js 22.13+ and npm 10+. Foundry with Solidity 0.8.28 is used for contract builds.

```sh
npm install
cp .env.example .env
npm run dev
```

The console runs at `http://127.0.0.1:5173`; the API runs at `http://127.0.0.1:4000`. The local app starts without external credentials. Keep `.env` private; only `.env.example` belongs in Git.

## Current status

<!-- BATON-STATUS:START -->

Updated 2026-11-06. Refresh with `npm run status:refresh` after either owner changes a gate.

| Owner | Updated | Next gate | Current work | Blockers |
|---|---|---|---|---|
| D1 | 2026-11-06 | Arkiv write/readback, then live Hedera x402 settlement with D2. | **Sepolia lifecycle: LIVE_PASS; full integration: pending.** ENS scoped grant/revoke and funded A-to-B escrow lifecycle passed. | Arkiv access/ownership and B-host recovery are pending; the API payment provider is still a local fixture. |
| D2 | 2026-11-06 | Join D1 for Arkiv/B-host recovery and the x402 payment-crash run. | Runtime, checkpoint, storage, tool, admission, and SQLite ledger modules are integrated. | Live Arkiv write/readback, separate B-host recovery, and real x402 settlement remain unverified. |

Feature code and local checks are not evidence of a live integration. See [gate evidence](docs/gates.md) for tested modes and results. The SQLite payment ledger and payment-crash recovery pass local checks recorded by the incoming branch; the current merge resolution has not been rerun. Checkpoints, artifacts, and paid output payloads are intended for Arkiv; no live write/readback is claimed.
<!-- BATON-STATUS:END -->

### Work completed on this branch

The current `build/runtime-recovery` branch contains the integrated D1 authority/payments and D2 runtime/recovery implementation.

- **Client and API:** React + TypeScript buyer console, Node.js + TypeScript API, protocol/status endpoints, and local job lifecycle.
- **Authority and rewards:** versioned protocol, EIP-712 signing helpers, Solidity escrow and job-authority sources, worker epoch fencing, and a local three-milestone acceptance flow.
- **Payment ledger:** SQLite operation ledger with durable reservations, settlement/reconciliation states, idempotency, budget conservation, concurrency control, and restart recovery. The API still uses a local payment-provider fixture; live x402 settlement is not enabled.
- **Recovery:** encrypted checkpoint and artifact manifests, Arkiv chunk adapter with local integrity and delta-reuse tests, deterministic and Beta-Bernoulli state import/export, and a local A-to-B worker handoff.
- **Tools and admission:** MCP discovery/invocation fixtures, candidate capability schema, and hard eligibility filtering.

### Verification

The incoming `build/runtime-recovery` branch records a successful `npm run verify` at commit `9976380`, including 15 local tests, Solidity compilation, the signing vector, and acceptance. D1's Sepolia lifecycle remains the live regression baseline. This merge resolution has not been rerun through `npm run verify`; its result is not being claimed here. Neither the recorded local verification nor the Sepolia escrow run made a live x402 payment or Arkiv content write.

### Sepolia progress

D1 reports that Sepolia ENS scoped grant, wrong-job denial, and revoke assertions passed. The funded lifecycle for job `cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3` completed 17 successful transactions: A withdrew 3 test tokens, B withdrew 7, takeover reached epoch 2, escrow ended at zero, and stale A rejection was confirmed by simulation. Public receipts are in [the Sepolia job evidence file](evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json). The live scripts and evidence are included in this merged checkout. ENS resolver and BATON adapter remain separate addresses.

### Remaining work

- Define Arkiv entity ownership and renewal authority, then perform a live encrypted write/readback.
- Validate recovery on Worker B's separate host using B's own local credentials.
- Integrate and validate a real Hedera x402 settlement; the API currently uses a local fixture.
- Review the one high and one low npm audit findings in the contract compiler dependency chain.

## Verify locally

```sh
npm run typecheck       # client and server TypeScript
npm run build           # client and server production builds
npm test                # D2 suites plus SQLite ledger and HTTP recovery tests
npm run test:signing    # deterministic EIP-712 hash/recovery vector
npm run test:local      # D1 authority, payment-budget and handoff acceptance fixture
npm run contracts:compile
npm run verify          # full local verification sequence
```

`npm run demo:local` demonstrates an encrypted A-to-B checkpoint handoff with synthetic batches and quantitative state. It makes no network calls. The D1 acceptance uses a local payment-provider fixture; it does not claim Hedera settlement.

## Architecture and data boundaries

- Sepolia escrow contracts hold reward terms, accepted heads, epochs, credits and refunds. Live ENS scoped grant, wrong-job denial, and revoke checks passed; the ENS resolver address is kept separate from BATON's adapter address.
- The buyer-host gateway uses SQLite for operation intents, reservations, settlement state and receipt/output references. `PAYMENT_LEDGER_PATH` defaults to `./data/payment-ledger.sqlite` relative to the server directory. The gateway is the only writer.
- Checkpoint manifests, artifacts and paid-output payloads are intended to be encrypted and stored in Arkiv. The adapter passes local tests, but live write/readback is unverified. There is no independent mirror or alternate content store.
- SQLite stores payment metadata, not content payloads. The payment ledger is not replicated to worker hosts.
- The local gateway provider and JSON job store are development fixtures. Sepolia/ENS authority checks passed, while live x402 settlement remains pending.

## API and project layout

The server exposes `/api/health`, `/api/status`, `/api/protocol`, job lifecycle routes, and service-operation quote/execute/reconcile routes. The local payment provider is explicitly a fixture.

```text
client/                         React + TypeScript + Vite buyer console
server/src/protocol/            Versioned job, checkpoint-head and payment types
server/src/chain/               EIP-712 helpers and signing vector
server/src/domain/jobs/         Local job/task lifecycle fixture
server/src/services/gateway/    Admission, spending and reconciliation flow
server/src/services/ledger/     SQLite payment-operation ledger
server/contracts/               Solidity escrow, authority adapter and ABIs
server/packages/checkpoint/     Encrypted recovery manifest
server/packages/storage/        Arkiv manifests and encrypted artifact chunks
server/packages/runtime/        Deterministic and quantitative state adapters
server/apps/worker/             Worker CLI and local handoff scenario
server/services/                Provider, MCP and candidate-admission adapters
scripts/                        Local scenarios, status refresh and contract checks
status/                         Per-owner progress and gate evidence
```

SQLite settings and current decisions are described in [BATON_Architecture.md](BATON_Architecture.md), [context.md](context.md), and [.env.example](.env.example). The build plan and ownership gates are in [plan.md](plan.md); test modes and live-read evidence are in [docs/gates.md](docs/gates.md).
