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

**Sepolia lifecycle: LIVE_PASS; full integration: pending.** The live Sepolia baseline includes the funded A-to-B handoff, milestone credits, both withdrawals, and zero escrow balance. Its public transaction evidence is recorded below. The current gateway reads Sepolia worker/epoch/grant/open state before accepting milestones or service operations, and locally checks drain and spending caps. That gateway path has mock-based local coverage; it has not yet been exercised against a fresh live job. The current service provider is still local, so it does not perform a real Hedera x402 payment. Arkiv writes and the joint live recovery flow remain pending.

### Latest Sepolia snapshot

- ENS resolver: `0x583fDD4b8d345624B1B8438Bd8ca5004bD0352bA`; BATON authority adapter: `0xD659F372D2439075F29e39f5E005d86352Da1A6c`. The user reports the live scoped ENS checks passed.
- Current escrow in ignored local `.env`: `0x4F802976810690F984cd05640a23b3FFB5B395E1`. The guarded replacement script only saves this field after a successful receipt and non-empty runtime code check. Its transaction hash is not yet in tracked evidence.
- Worker A: `0x432Eeff3E312f1910F3D04A6449753306fFaA5D2`; Worker B: `0x70F6F8b58c127d6e83E7198053F4403e6d2aBFE5`.
- Worker A's configured Arkiv signer derives to its public address. The ignored local `.env` is missing `ARKIV_ACCESS_KEY`, so no live Arkiv write has been verified. No worker-specific env files are present in this checkout.
- Live funded job `0xcef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3` completed against the existing escrow without redeploying it. The run accepted A’s 3-token milestone, transferred assignment to B at epoch 2, accepted B’s 3- and 4-token milestones, and confirmed claims of 3 tokens by A and 7 by B. Each of the 17 submitted transactions had a successful receipt with two confirmations.
- The stale A milestone was simulated after takeover and reverted with `StaleEpoch` via `eth_call`; it was not sent as a reverting transaction. Final token balances were A `3`, B `7`, escrow `0` (18 decimals). Reward token: test-only `BatonTestToken` at `0x6044f549F604A02bA66Ac60d2Aed35fFcCAbb6f9`; it is permissionless to mint and is only for Sepolia acceptance, not a real-value asset.
- Full transaction and receipt evidence: [evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json](evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json). The run was launched from Mac Terminal because this execution sandbox cannot resolve the Sepolia RPC host.

The local gateway regression also covers stale/revoked chain workers, over-cap requests, retained UNKNOWN reservations, and a simulated post-settlement crash where B reuses A's paid output after stores are reopened. The crash case uses a fake provider and proves local idempotency only; it is not a Hedera settlement.

Public configuration and needed actions are tracked in [`status/d1.json`](status/d1.json) and [`requests.md`](requests.md). The full scope and D1/D2 allocation remain in [`plan.md`](plan.md).

## Getting started

Requirements: Node.js 22.12 or newer and npm. Foundry plus Solidity 0.8.28 are needed for contract development. Local service state uses atomic JSON files under `.baton-data/`; the ledger interface is isolated so it can be replaced by the planned SQLite adapter without changing gateway behavior.

```sh
npm install
cp .env.example .env
npm run dev
```

The client runs at `http://127.0.0.1:5173`; the API runs at `http://127.0.0.1:4000`. The health endpoint is `/api/health`. Fill the relevant `.env` values before connecting any external integration. The server loads the checkout root `.env` with `dotenv`; inherited process variables take precedence unless cleared before startup. Keep `.env` private; only `VITE_*` variables are exposed to browser code.

## Verification commands

```sh
npm run typecheck       # client and server TypeScript
npm run build           # production client and server builds
npm run test:signing    # deterministic EIP-712 hash/recovery vector
npm run test:local      # isolated durable-ledger and handoff acceptance
npm run verify          # all of the above
forge build             # escrow sources, when solc 0.8.28 is available
npm run deploy:sepolia:escrow  # deploys JobEscrow after local RPC/key configuration
npm run deploy:sepolia:escrow:replace # deploys a new escrow and replaces the address after verification
npm run test:sepolia:authority # deploys/checks ENS adapter and runs scoped grant assertions
npm run test:sepolia:worker-grants # checks scoped grants for WORKER_A_ADDRESS and WORKER_B_ADDRESS
npm run demo:sepolia:job-lifecycle # funded A-to-B escrow lifecycle; reuses BATON_ESCROW_ADDRESS
```

The local acceptance prints machine-readable evidence. It creates a funded job with rewards `3/3/4` and a separate `20 HBAR` service budget, assigns A, settles one paid operation, accepts a checkpoint, drains the gateway, transfers the task to B, rejects stale A requests, settles two B operations, accepts the remaining checkpoints, and verifies A/B claims of `3/7`. It also checks stable-operation idempotency, UNKNOWN reservation retention, authority-reader rejection paths, spending caps, and one-provider-call payment-crash recovery. All payment and chain checks in this local acceptance are simulated.

## Authority and spending API

The server exposes the local integration boundary used by the console and worker layers:

| Route | Purpose |
|---|---|
| `POST /api/jobs` | Freeze job terms, milestones and service policy; configure the ledger budget |
| `POST /api/jobs/:id/assign` | Assign the initial worker and establish epoch 1 |
| `POST /api/jobs/:id/checkpoints` | Verify the expected head, local worker/epoch, and live chain authority when configured before accepting the milestone locally |
| `POST /api/jobs/:id/drain` | Stop new gateway admissions before handoff |
| `POST /api/jobs/:id/takeover` | Require exact head/epoch and a compatibility commitment, then increment epoch |
| `POST /api/jobs/:id/services/execute` | Reserve budget before provider submission and persist the receipt/output reference |
| `POST /api/services/operations/:operationId/reconcile` | Reconcile an uncertain operation without blind repayment |
| `POST /api/jobs/:id/claim` | Mark immutable worker credits withdrawn once |

All amounts are integer base units and are serialized as strings ending in `n` in JSON responses. The local payment provider is explicitly a fixture (`local-hedera-receipt:*`); it is not a Hedera settlement claim. Testnet mode must be added only after the configured facilitator, payer, payee, asset, and network are independently verified.

## Sepolia escrow deployment

The local `.env` is ignored and must remain private. Enter the testnet deployer key there locally; never pass it on a command line or in chat. The deploy command compiles `JobEscrow`, checks that the RPC reports Sepolia chain ID `11155111`, checks the deployer balance, submits the deployment, waits for confirmations, verifies code at the receipt address, and only then updates `BATON_ESCROW_ADDRESS`. It refuses a duplicate deployment when that variable is already populated. The `.env` file is set to owner-only permissions (`0600`).

```sh
npm run deploy:sepolia:escrow
```

When intentionally deploying a fresh escrow over an existing configured address, use `npm run deploy:sepolia:escrow:replace`. It first verifies the configured ENS resolver and BATON authority adapter, then stores the new `BATON_ESCROW_ADDRESS` only after a successful receipt and non-empty runtime code check.

## Sepolia ENS authority adapter

`ENS_RESOLVER_ADDRESS` stores the real resolver returned for `ENS_JOB_NAME`; `BATON_AUTHORITY_ADAPTER_ADDRESS` stores BATON's separate `JobAuthority` contract. `JobAuthority` checks ENSv2 `ROLE_SET_DATA` on the resource for `baton.job.v1:<lowercase-job-id>`, so each job grant is scoped to its own data key. Configure `ENS_JOB_NAME` and the Sepolia RPC in ignored `.env`, then run:

```sh
npm run test:sepolia:authority
```

The workflow resolves the name live, checks resolver admin access, deploys the adapter only when its address is unset, then verifies grant → authorized, wrong job → unauthorized, and revoke → unauthorized. It saves the real resolver and adapter addresses to distinct `.env` fields only after all assertions pass. The deployer key stays private and the test grant is revoked.

For the actual worker pair, the public `WORKER_A_ADDRESS` and `WORKER_B_ADDRESS` values are configured in local `.env`. The current escrow is already configured; there is no need to replace it to run `npm run test:sepolia:worker-grants`. The script uses the deployer key only to grant/revoke each worker's temporary job-key role, checks correct-job and wrong-job results through the adapter, and revokes each grant before returning. It refuses to run if either worker already has a resolver-wide `ROLE_SET_DATA` grant, so the revoke assertion remains meaningful.

The funded A-to-B flow has completed against the existing escrow; its receipts are in the linked evidence file above. The runner does not deploy or replace `BATON_ESCROW_ADDRESS`. The recorded reward token is test-only. A repeat run needs at least 10 tokens in the buyer balance: the current runner does not mint again once `BATON_REWARD_TOKEN_ADDRESS` is populated, and this run allocated the full 10-token balance.

The client communicates with the server API. Chain access, payment authority, encryption keys, and provider credentials stay out of browser code. Worker processes may run on separate hosts and use the shared server-side packages; a checkpoint or API request does not itself grant tool or data access.

The browser remains deliberately thin: chain access, payer authority, encryption keys and provider credentials stay server-side. A checkpoint or API request does not grant tool or data access. The API's local adapter is fail-closed on stale workers, paused/drained tasks, wrong assets/services, cap violations, replayed operation keys and uncertain settlement.

## Dependencies and configuration

The client includes React, TypeScript, Vite, viem, and ENSjs. The server includes Express, Arkiv SDK, viem, ENSjs, Hiero's Hedera SDK, x402 core/fetch/Hedera, the MCP SDK, and OpenZeppelin contracts. The D1 ledger/gateway boundary is implemented in `server/src/services/ledger` and `server/src/services/gateway`; the external Arkiv/Hedera adapters remain separate integration work.

All checkpoint and task-artifact content is planned for encrypted Arkiv entities. The root `.env.example` covers local ports, Sepolia/ENS deployments, Arkiv access and signers, worker signing, checkpoint key access, and Hedera x402 credentials. Set these when implementing the corresponding integration. Arkiv entity ownership and renewal authority still need to be finalized before live storage writes.
