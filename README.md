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

Generated 2026-11-05T22:40:16.960Z · working tree based on commit `49394af`. Refresh with `npm run status:refresh`. Status older than 60 minutes is marked STALE.

| Owner | Updated | Next gate | Current work | Blockers |
|---|---|---|---|---|
| D1 | 2026-11-06T04:09:41+05:30 | H00:00 · Confirm the ENS resolver/name pairing, then validate a live Hedera x402 settlement. | Reconcile the current ENS resolver settings and complete Hedera x402 integration. | The latest local read-only check found ENS_RESOLVER_ADDRESS did not match the resolver returned for ENS_JOB_NAME; recheck before another authority run.; A live Hedera x402 provider/facilitator and proven settlement are not configured; this API still uses its local payment fixture. |
| D2 | 2026-11-06T04:09:41+05:30 | H05:52 · Reconcile current ENS resolver settings, verify Arkiv ownership/readback, and confirm B-host recovery. | D1 and D2 code are integrated on build/runtime-recovery; combined post-merge verification passed on build/authority-payments. | The latest local probe found ENS_RESOLVER_ADDRESS did not match the resolver currently returned for ENS_JOB_NAME; the separate BATON adapter was not probed in that check.; Arkiv content write/readback and entity ownership/renewal policy remain unverified.; No x402 payment was attempted; the API provider remains a local fixture.; B-host availability for isolated cold recovery is unconfirmed.; The combined npm audit reports one high and one low advisory in the development compiler dependency chain; no fix has been applied. |

Feature code and local checks are not evidence of a live integration. See [gate evidence](docs/gates.md) for tested modes and results. The SQLite payment ledger passes local transaction and restart checks; the provider remains a fixture. Checkpoints, artifacts, and paid output payloads are intended for Arkiv; no live write/readback or independent content mirror is claimed.
<!-- BATON-STATUS:END -->

### Work completed on this branch

The current `build/runtime-recovery` branch contains the integrated D1 authority/payments and D2 runtime/recovery implementation.

- **Client and API:** React + TypeScript buyer console, Node.js + TypeScript API, protocol/status endpoints, and local job lifecycle.
- **Authority and rewards:** versioned protocol, EIP-712 signing helpers, Solidity escrow and job-authority sources, worker epoch fencing, and a local three-milestone acceptance flow.
- **Payment ledger:** SQLite operation ledger with durable reservations, settlement/reconciliation states, idempotency, budget conservation, concurrency control, and restart recovery. The API still uses a local payment-provider fixture; live x402 settlement is not enabled.
- **Recovery:** encrypted checkpoint and artifact manifests, Arkiv chunk adapter with local integrity and delta-reuse tests, deterministic and Beta-Bernoulli state import/export, and a local A-to-B worker handoff.
- **Tools and admission:** MCP discovery/invocation fixtures, candidate capability schema, and hard eligibility filtering.

### Verification

The combined D1/D2 code passed `npm run verify` after this branch was integrated into local branch `build/authority-payments` at commit `9976380`. Client/server typechecks and production builds passed, as did all 15 tests, Solidity compilation, the EIP-712 signing vector, and local acceptance. The 15 tests cover checkpoint encryption (4), storage (2), runtime (2), worker handoff (1), tools (1), admission (1), SQLite ledger (3), and API restart recovery (1). The local acceptance confirmed A/B credits of 3/7, stale-worker rejection, idempotency, and an UNKNOWN reservation held across restart. The verification sent no Sepolia transactions and made no x402 payments.

### Sepolia progress

D1 reports that scoped ENS grant, wrong-job denial, and revoke assertions passed. D1 also reports a funded Sepolia A-to-B lifecycle for job `cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3`: 17 successful transactions, A claimed 3 test tokens, B claimed 7, and stale A was rejected by a simulated `StaleEpoch` revert. The transaction evidence and runnable Sepolia scripts are currently on `build/authority-payments`; they are not present in this checkout. Although [test.md](test.md) lists live command names, this branch's `package.json` does not yet define those Sepolia scripts.

The latest read-only check recorded on 2026-11-06 reached Sepolia but found that `ENS_RESOLVER_ADDRESS` did not match the resolver returned for `ENS_JOB_NAME`. It did not probe the separate `BATON_AUTHORITY_ADAPTER_ADDRESS`. Reconcile the resolver/name settings before repeating authority checks.

### Remaining work

- Verify the current ENS resolver/name configuration and integrate the live authority workflows into this branch.
- Define Arkiv entity ownership and renewal authority, then perform a live encrypted write/readback.
- Validate recovery on Worker B's separate host.
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
