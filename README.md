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

Generated 2026-11-05T19:55:42.948Z · working tree based on commit `962ccf1`. Refresh with `npm run status:refresh`. Status older than 60 minutes is marked STALE.

| Owner | Updated | Next gate | Current work | Blockers |
|---|---|---|---|---|
| D1 | STALE (2026-11-05T22:41:53+05:30) | H00:00 · Connect configured Sepolia/ENS authority and real Hedera x402 provider | Authority, rewards, spending and local acceptance flow | Sepolia RPC, deployed escrow and ENS resolver addresses are not configured in .env; Hedera payer/facilitator credentials and a proven x402 endpoint are not configured |
| D2 | 2026-11-06T01:25:11+05:30 | H03:07 · G2: live Arkiv/Sepolia/ENS verification and B-host cold recovery | Integrated D1 authority/payments with D2 recovery; SQLite ledger and full local verification pass. | CHECKPOINT_ENCRYPTION_KEY was missing or invalid at the last redacted check; Arkiv content write/readback and ownership/renewal policy remain unverified; SEPOLIA_RPC_URL, BATON_ESCROW_ADDRESS, and ENS_RESOLVER_ADDRESS were missing at the last redacted check; Sepolia/ENS reads remain unverified; No x402 payment was attempted; the integrated payment provider is still a local fixture; B-host availability for isolated cold recovery is unconfirmed; User-directed Arkiv-only content storage overrides plan.md mirror scenarios; npm install reported two dependency advisories, including one high severity; they have not been reviewed or fixed |

Feature code and local checks are not evidence of a live integration. See [gate evidence](docs/gates.md) for tested modes and results. The SQLite payment ledger passes local transaction and restart checks; the provider remains a fixture. Checkpoints, artifacts, and paid output payloads are intended for Arkiv; no live write/readback or independent content mirror is claimed.
<!-- BATON-STATUS:END -->

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

- Sepolia escrow contracts hold reward terms, accepted heads, epochs, credits and refunds. The ENS adapter reads an explicit job-scoped resolver; deployed addresses and permissions remain unverified.
- The buyer-host gateway uses SQLite for operation intents, reservations, settlement state and receipt/output references. `PAYMENT_LEDGER_PATH` defaults to `./data/payment-ledger.sqlite` relative to the server directory. The gateway is the only writer.
- Checkpoint manifests, artifacts and paid-output payloads are intended to be encrypted and stored in Arkiv. The adapter passes local tests, but live write/readback is unverified. There is no independent mirror or alternate content store.
- SQLite stores payment metadata, not content payloads. The payment ledger is not replicated to worker hosts.
- The local gateway provider and JSON job store are development fixtures; live Sepolia, ENS and x402 authorization/settlement remain separate integration gates.

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
