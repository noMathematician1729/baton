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
```

## Getting started

Requirements: Node.js 22.12 or newer and npm. Foundry is needed for contract development. The payment-ledger backend (Arkiv vs PostgreSQL) is deferred; the local scaffold has no database requirement.

```sh
npm install
cp .env.example .env
npm run dev
```

The client runs at `http://127.0.0.1:5173`; the API runs at `http://127.0.0.1:4000`. The health endpoint is `/api/health`. Fill the relevant `.env` values before connecting any external integration. Keep `.env` private; only `VITE_*` variables are exposed to browser code.

The client communicates with the server API. Chain access, payment authority, encryption keys, and provider credentials stay out of browser code. Worker processes may run on separate hosts and use the shared server-side packages; a checkpoint or API request does not itself grant tool or data access.

This repository currently contains the project skeleton only. The integrations and guarantees in the architecture documents are design requirements, not implemented or verified behavior.

## Dependencies and configuration

The client includes React, TypeScript, Vite, viem, and ENSjs. The server includes Express, Arkiv SDK, viem, ENSjs, Hiero's Hedera SDK, x402 core/fetch/Hedera, the MCP SDK, and OpenZeppelin contracts. PostgreSQL's `pg` driver remains available as a candidate ledger adapter; no database connection is initialized.

All checkpoint and task-artifact content is planned for encrypted Arkiv entities. The root `.env.example` covers local ports, Sepolia/ENS deployments, Arkiv access and signers, worker signing, checkpoint key access, and Hedera x402 credentials. Set these when implementing the corresponding integration. Arkiv entity ownership and renewal authority still need to be finalized before live storage writes.
