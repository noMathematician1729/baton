# BATON

BATON is a client/server monorepo. The React buyer console is the client; the Node.js API, worker execution, domain services, persistence adapters, and contract sources live under the server.

```text
client/                         Buyer-facing frontend
  package.json                  React, TypeScript, Vite
  src/
    app/                        Application shell and navigation
    features/
      jobs/                     Job setup and status
      checkpoints/              Checkpoint review and recovery
      handoff/                  Worker assignment and takeover
      receipts/                 Reward and service receipts
    lib/api/                    Typed calls to the server API

server/                         Backend and worker-side code
  package.json                  Node.js, TypeScript, Arkiv, ENS, x402
  src/
    api/                        HTTP routes and request validation
    config/                     Environment-backed configuration
    domain/jobs/                Job and task rules
    services/
      admission/                Eligibility and compatibility checks
      access/                   Scoped tool and data access
      payments/                 Hedera x402 gateway and budget controls
      ledger/                   Durable service-operation records
      verifier/                 Deliverable and checkpoint verification
    worker/                     Worker CLI and execution orchestration
  contracts/
    src/                        Sepolia escrow and ENS authority contracts
    test/                       Contract tests
    foundry.toml                Foundry project configuration
  packages/
    checkpoint/src/             Portable checkpoint schema and crypto
    storage/src/                Arkiv manifests, artifact chunks, and retention
    runtime/src/                Worker state export/import and reconstruction

BATON_Architecture.md            Detailed architecture and invariants
context.md                       Product context and demo requirements
plan.md                          24-hour ownership, gates and acceptance checklist
status/d1.json                   D1 machine-readable status
requests.md                      Public-input queue; no secrets
```

## Current status

The D1 authority/payments slice is locally verified. It has a versioned protocol, canonical SHA-256 commitments, EIP-712 offer/takeover hash helpers, a durable atomic operation ledger, service-budget reservations, UNKNOWN handling, worker epoch fencing, an end-to-end local 3/3/4 handoff acceptance run, and Solidity 0.8.28 compilation with tracked ABIs. Live Sepolia, ENS, Arkiv and Hedera integrations are pending.

No Sepolia, ENS, Arkiv or Hedera live pass is claimed yet. Public configuration and needed actions are tracked in [`status/d1.json`](status/d1.json) and [`requests.md`](requests.md). The full scope and D1/D2 allocation remain in [`plan.md`](plan.md).

## Getting started

Requirements: Node.js 22.12 or newer and npm. Foundry plus Solidity 0.8.28 are needed for contract development. Local service state uses atomic JSON files under `.baton-data/`; the ledger interface is isolated so it can be replaced by the planned SQLite adapter without changing gateway behavior.

```sh
npm install
cp .env.example .env
npm run dev
```

The client runs at `http://127.0.0.1:5173`; the API runs at `http://127.0.0.1:4000`. The health endpoint is `/api/health`. Fill the relevant `.env` values before connecting any external integration. Keep `.env` private; only `VITE_*` variables are exposed to browser code.

## Verification commands

```sh
npm run typecheck       # client and server TypeScript
npm run build           # production client and server builds
npm run test:signing    # deterministic EIP-712 hash/recovery vector
npm run test:local      # isolated durable-ledger and handoff acceptance
npm run verify          # all of the above
forge build             # escrow sources, when solc 0.8.28 is available
```

The local acceptance prints machine-readable evidence. It creates a funded job with rewards `3/3/4` and a separate `20 HBAR` service budget, assigns A, settles one paid operation, accepts a checkpoint, drains the gateway, transfers the task to B, rejects stale A requests, settles two B operations, accepts the remaining checkpoints, and verifies A/B claims of `3/7`. It also checks stable-operation idempotency and that UNKNOWN keeps its reservation held.

## Authority and spending API

The server exposes the local integration boundary used by the console and worker layers:

| Route | Purpose |
|---|---|
| `POST /api/jobs` | Freeze job terms, milestones and service policy; configure the ledger budget |
| `POST /api/jobs/:id/assign` | Assign the initial worker and establish epoch 1 |
| `POST /api/jobs/:id/checkpoints` | Verify the expected head and accept the next fixed milestone |
| `POST /api/jobs/:id/drain` | Stop new gateway admissions before handoff |
| `POST /api/jobs/:id/takeover` | Require exact head/epoch and a compatibility commitment, then increment epoch |
| `POST /api/jobs/:id/services/execute` | Reserve budget before provider submission and persist the receipt/output reference |
| `POST /api/services/operations/:operationId/reconcile` | Reconcile an uncertain operation without blind repayment |
| `POST /api/jobs/:id/claim` | Mark immutable worker credits withdrawn once |

All amounts are integer base units and are serialized as strings ending in `n` in JSON responses. The local payment provider is explicitly a fixture (`local-hedera-receipt:*`); it is not a Hedera settlement claim. Testnet mode must be added only after the configured facilitator, payer, payee, asset, and network are independently verified.

The client communicates with the server API. Chain access, payment authority, encryption keys, and provider credentials stay out of browser code. Worker processes may run on separate hosts and use the shared server-side packages; a checkpoint or API request does not itself grant tool or data access.

The browser remains deliberately thin: chain access, payer authority, encryption keys and provider credentials stay server-side. A checkpoint or API request does not grant tool or data access. The API's local adapter is fail-closed on stale workers, paused/drained tasks, wrong assets/services, cap violations, replayed operation keys and uncertain settlement.

## Dependencies and configuration

The client includes React, TypeScript, Vite, viem, and ENSjs. The server includes Express, Arkiv SDK, viem, ENSjs, Hiero's Hedera SDK, x402 core/fetch/Hedera, the MCP SDK, and OpenZeppelin contracts. The D1 ledger/gateway boundary is implemented in `server/src/services/ledger` and `server/src/services/gateway`; the external Arkiv/Hedera adapters remain separate integration work.

All checkpoint and task-artifact content is planned for encrypted Arkiv entities. The root `.env.example` covers local ports, Sepolia/ENS deployments, Arkiv access and signers, worker signing, checkpoint key access, and Hedera x402 credentials. Set these when implementing the corresponding integration. Arkiv entity ownership and renewal authority still need to be finalized before live storage writes.
