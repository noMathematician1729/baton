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
| D1 | 2026-11-06 | Finish the checkpoint candidate verifier and signed HTTP route checks, then run buyer-owned Arkiv recovery and real x402 with D2. | **Sepolia lifecycle: LIVE_PASS; full integration: pending.** G1 contract regressions, G2 buyer-signed initial import/auth/confirmed reads, G3 cold-recovery boundary/key service, and G4 SQLite settlement safeguards have local implementation slices. | No repaired escrow deployment, live Arkiv read/write, grant to a live accepted head, real x402 settlement, or separate-host recovery has been verified. |
| D2 | 2026-11-06 | Review the shared checkpoint/recovery and provider boundaries, then join the live A-to-B run. | Last recorded status reports runtime, checkpoint, storage, tool, admission, and SQLite ledger integration; no new D2 G0–G4 status is recorded on this branch. | Live Arkiv read/write, separate B-host recovery, and real x402 settlement remain unverified. |

Feature code and local checks are not evidence of a live integration. See [gate evidence](docs/gates.md) for tested modes and results. The candidate on `build/audit-g0-g4` is based on `1e21837e5ed83c2b96c42a000d8b765cdd2e7460`. The payment-crash scenario is a local fixture; no live Arkiv or x402 write is claimed.
<!-- BATON-STATUS:END -->

### Work completed on this branch

The integrated D1 authority/payments and D2 runtime/recovery implementation is the baseline for the current `build/audit-g0-g4` remediation branch.

- **Client and API:** React + TypeScript buyer console, Node.js + TypeScript API, protocol/status endpoints, and local job lifecycle.
- **Authority and rewards:** versioned protocol, EIP-712 signing helpers, Solidity escrow and job-authority sources, worker epoch fencing, and a local three-milestone acceptance flow.
- **Payment ledger:** SQLite operation ledger with stable logical fingerprints, durable reservations, explicit settled/not-settled/unknown reconciliation, per-operation budget checks, concurrency control, and restart recovery. The API still uses a local payment-provider fixture; live x402 settlement is not enabled.
- **Recovery:** encrypted checkpoint and artifact manifests, bounded Arkiv chunk reads, exact accepted-head recovery validation, a buyer-host key service with per-worker tokens and encrypted key transport, a TLS key-grant client, deterministic and Beta-Bernoulli state adapters, and a local A-to-B worker handoff. The key service passes a local fixture check; a live accepted-checkpoint grant and B-host topology remain pending. D2 will decide whether a temporary tunnel is needed.
- **Tools and admission:** MCP discovery/invocation fixtures, candidate capability schema, and hard eligibility filtering.

### Verification

Current local checks pass: client/server typecheck and production build; 42 offline tests including in-process Express route dispatch; `npm run key-service:smoke` with B-only decryption and A/identity-spoof denial; `npm run test:local` including one simulated provider purchase reused by B; the signing vector; Solidity compilation; and nine Foundry regressions. D1's latest local changes also bind operation fingerprints to provider/network/payee/policy, import only buyer-signed pristine chain-job snapshots, and recover job/budget provisioning after either cross-store crash window. The route checks cover production import gating and unsigned action rejection, but not the full route matrix. An earlier API SQLite restart check passed 1/1 on the user's Mac, before the new provisioning journal path. The HTTP listener integration rerun is unverified because this sandbox denies loopback listeners with `EPERM`; rerun `node --import tsx --test server/src/app.integration.test.ts` on a local machine. Foundry used solc 0.8.38, while `foundry.toml` and `package-lock.json` specify 0.8.28, so compiler parity remains open. No Sepolia transaction, Arkiv write, or x402 payment was made in this pass. The key-service fixture is local only; no real accepted checkpoint has been granted.

### Sepolia progress

D1 reports that Sepolia ENS scoped grant, wrong-job denial, and revoke assertions passed. The historical funded lifecycle for job `cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3` completed 17 successful transactions: A withdrew 3 test tokens, B withdrew 7, takeover reached epoch 2, escrow ended at zero, and stale A rejection was confirmed by simulation. Public receipts are in [the Sepolia job evidence file](evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json). This is the live baseline; the revised V2 escrow ABI has not been deployed or tested live. ENS resolver and BATON adapter remain separate addresses.

### Remaining work

- Start the key service on the buyer host, grant B the exact live accepted checkpoint, and perform buyer-owned Arkiv write/readback and clean-host recovery. Add a temporary HTTPS tunnel only if D2 confirms B runs on another machine.
- Configure `ARKIV_RPC_URL` and `ARKIV_SIGNER_PRIVATE_KEY` privately; choose and verify buyer-controlled Arkiv ownership/renewal.
- Connect the exact confirmed on-chain accepted-head reader and candidate verifier to the recovery helper; validate recovery on Worker B's separate host with B's credentials.
- Integrate a provider that can look up settlement and output by stable operation ID, persist paid bytes in Arkiv, and verify actual debit. The API currently uses a local fixture.
- Restore lockfile/node_modules parity and resolve the `solc`/`tmp` advisories. Registry DNS prevented fetching the patched `tmp` release; the lockfile was left unchanged.

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
