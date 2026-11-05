# BATON

BATON is a client/server monorepo for resumable work. The React + TypeScript client is the buyer console; the Node.js + TypeScript server contains the API, worker packages, and Web3 integrations.

## Quick start

Requirements: Node.js 22.12+ and npm 10+.

```sh
npm install
cp .env.example .env
npm run dev
```

The console runs at `http://127.0.0.1:5173`; the API runs at `http://127.0.0.1:4000`. The local app starts without credentials. Fill `.env` values only when exercising the matching integration, and keep all secret values out of browser variables and source control.

## Current status

<!-- BATON-STATUS:START -->

Generated 2026-11-05T17:51:20.144Z · working tree based on commit `796151b`. Refresh with `npm run status:refresh`. Status older than 60 minutes is marked STALE.

| Owner | Updated | Next gate | Current work | Blockers |
|---|---|---|---|---|
| D1 | NOT REPORTED | — | — | status/d1.json is missing |
| D2 | 2026-11-05T23:20:30+05:30 | H01:03 · G1/H02 (2026-11-06 00:17 IST); B-host availability input due H01 | Final pre-push verification complete; resolve remaining env and shared-protocol blockers for H02. | D1 protocol stub and signing vectors are not present in this checkout; D1 is not ready; CHECKPOINT_ENCRYPTION_KEY is missing or invalid; Arkiv content write/readback remains unverified; SEPOLIA_RPC_URL, BATON_ESCROW_ADDRESS, and ENS_RESOLVER_ADDRESS are missing; Sepolia/ENS reads remain unverified; No x402 payment was attempted; SQLite ledger implementation and settlement recovery are pending; User-directed Arkiv-only content storage overrides plan.md mirror scenarios; SQLite payment-ledger implementation and transaction/recovery tests remain pending |

Feature code and local checks are not evidence of a live integration. See [gate evidence](docs/gates.md) for tested modes and results. The payment-operation ledger is assigned to SQLite; its implementation remains pending. Checkpoints, artifacts, and paid output payloads are stored in Arkiv; there is no independent mirror or alternate artifact store.
<!-- BATON-STATUS:END -->

## Run locally

```sh
npm run demo:local       # encrypted A-to-B checkpoint and quantitative-state continuation
npm run tools:mcp         # launch the synthetic MCP service over stdio
npm test                 # local checkpoint, worker, runtime, MCP tool, and admission checks
npm run typecheck
npm run build
npm run status:refresh   # merge D1/D2 status files into this README section
```

The local demo uses a synthetic fixture and a demo-only encryption key. It makes no network calls and does not establish Arkiv, ENS, Sepolia, or Hedera connectivity.

## Repository layout

```text
client/                         React + TypeScript + Vite buyer console
  src/app/                      Console shell and integration status
  src/lib/api/                  Typed calls to the server API
server/                         Node.js + TypeScript backend
  src/                          Express API and environment configuration
  apps/worker/                  Worker CLI and local handoff scenario
  packages/checkpoint/          Versioned manifest schema and AES-GCM envelope
  packages/runtime/             Deterministic and Beta-Bernoulli state adapters
  packages/storage/             Encrypted Arkiv entities and artifact chunks
  services/admission/           Candidate hard-filter and price ranking
  services/provider/            Hedera x402 client adapter
  services/tools/               Synthetic MCP service and conformance probe
scripts/scenarios/              Human-runnable local scenarios
scripts/status/                 README status generation
status/                         Per-owner progress reports
docs/gates.md                   Local/live evidence and human checks
```

## Integrations and decisions

- Checkpoints and task artifacts are encrypted before they are written to Arkiv. No independent mirror or alternate artifact store is used.
- SQLite is selected for the buyer-host service-payment operation ledger. `PAYMENT_LEDGER_PATH` names its local file; implementation and transaction/recovery tests are still pending.
- The SQLite ledger stores operation and payment metadata. Encrypted paid outputs, checkpoints, and task artifacts remain in Arkiv.
- Arkiv writes are not yet demonstrated live. Entity ownership and renewal authority must be finalized before enabling them.
- `/api/status` reports whether environment variables are present. “Configured” is not a live connectivity or acceptance result.
- `.env.example` lists local, Sepolia/ENS, Arkiv, worker-key, checkpoint-key, and Hedera x402 settings. Keep real credentials in the ignored local `.env` or a host keystore.

See [context.md](context.md) for current product/storage decisions, [plan.md](plan.md) for the build gates, and [BATON_Architecture.md](BATON_Architecture.md) for the architecture and invariants.
