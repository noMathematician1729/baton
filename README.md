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

Generated 2026-11-06T10:33:15.511Z · working tree based on commit `a155b5e`. Refresh with `npm run status:refresh`. Status older than 60 minutes is marked STALE.

| Owner | Updated | Next gate | Current work | Blockers |
|---|---|---|---|---|
| D1 | STALE (2026-11-06T10:30:11+05:30) | H00:45 · Review and deploy the revised V2 escrow when live verification is authorized and RPC is reachable; then exercise the D1 mutation writer and coordinate D2's live Arkiv/x402 recovery proof | G0-G4 D1 audit remediation on build/audit-g0-g4; production escrow mutation writer, worker offer/ack verification, signed worker claim relay and confirmed post-write checks implemented and locally tested; live V2 and Arkiv/x402 integration remain pending | npm registry DNS prevented a verified tmp 0.2.7 lockfile fix; package-lock.json remains unchanged; Root .env is ignored and mode 0600; ARKIV_ACCESS_KEY and CHECKPOINT_ENCRYPTION_KEY are configured, while ARKIV_RPC_URL and ARKIV_SIGNER_PRIVATE_KEY are missing; Key-service URLs are loopback for same-laptop use; D2 has not confirmed whether B is cross-host, and no grant exists for a real accepted checkpoint; The service process is not left running by this execution shell; start it on the buyer host. A temporary tunnel is conditional on D2 confirming cross-host workers; Latest API integration rerun for job provisioning is unverified because this sandbox denies loopback listeners with EPERM; No live Arkiv write/read, buyer-owned renewal, real x402 settlement/output lookup, or B-host recovery has been demonstrated; The revised V2 escrow is not deployed; production writer behavior is locally tested only and no live V2 mutation or accepted-checkpoint grant has been verified |
| D2 | 2026-11-06T16:00:35+05:30 | H17:43 · Review the V2 contract delta and configure its replacement, then run the prepared 3/3/4-token Sepolia lifecycle. Continue Arkiv, paid-service, accepted-checkpoint grant, and cross-host recovery proof as separate live gates. | Merge a155b5e is pushed to origin/build/audit-g0-g4. Confirmed Sepolia escrow mutations and x402 challenge policy are integrated with D2 recovery/payment-output work; Worker B's suffixed environment mapping excludes buyer/A signers. `npm run verify` passes 117 tests and Foundry passes 17/17. API, client, and key service are healthy; a complete V2 lifecycle job is prepared but blocked before creation/funding by the configured V1 escrow. No new live transaction, Arkiv write, or x402 payment was sent. | The configured Sepolia escrow is the historical V1 deployment and does not expose the V2 protocol marker; the prepared fresh test job cannot be submitted until a replacement escrow is deployed and configured; The root .env has no generic buyer-owned ARKIV_RPC_URL or ARKIV_SIGNER_PRIVATE_KEY; /api/status reports contentStore=unconfigured, so live buyer-owned checkpoint writes/readback/renewal are not configured; The HEDERA_PAID_SERVICE_URL, HEDERA_PAID_STATUS_URL_TEMPLATE and HEDERA_PAID_OUTPUT_URL_TEMPLATE values are absent; the implemented client is not enabled and the API remains on LocalPaymentProvider; Worker B's .env.worker-b has no MCP_SERVER_URL or MCP_API_KEY, so the authenticated live capability probe cannot run; The buyer-host key service is running on loopback, but no real accepted-checkpoint grant exists and Worker B separate-host availability remains unconfirmed; G2 lifecycle writes and post-write reads have fake-backed route/authority coverage; live verification remains pending because the configured escrow is V1 and B's live capability evidence remains open; Historical ENS/lifecycle evidence proves the earlier deployment only; it is not current V2 end-to-end proof |

Local implementation and historical Sepolia evidence do not establish the full integration. See [gate evidence](docs/gates.md). Worker B cold recovery and the G4 x402/Arkiv output boundary pass local fake-backed checks; the opt-in G5 policy runner is not live-verified. Gate 6 remains BLOCKED: the configured escrow is V1, buyer-owned Arkiv writes/renewal and a real accepted checkpoint are pending, no concrete paid-service API with authoritative idempotent status/output lookup is configured, and live separate-host B recovery is unverified. Historical Sepolia lifecycle: LIVE_PASS; current full integration: pending.
<!-- BATON-STATUS:END -->

### Work completed on this branch

The integrated D1 authority/payments and D2 runtime/recovery implementation is the baseline for the current `build/audit-g0-g4` remediation branch.

- **Client and API:** React + TypeScript buyer console, Node.js + TypeScript API, protocol/status endpoints, and local job lifecycle.
- **Authority and rewards:** versioned protocol, EIP-712 signing helpers, Solidity escrow and job-authority sources, worker epoch fencing, and a local three-milestone acceptance flow. Initial assignment is buyer-controlled and requires a grant scoped to the job; the current ABI does not require a worker consent signature.
- **Confirmed escrow writes:** buyer mutations use a Sepolia writer that simulates each call and waits for the configured confirmations. Worker reward claims relay only a worker-signed transaction bound to the configured chain, escrow, exact `claim(jobId)` call, zero value, and recovered sender. Local fake-backed tests cover post-write state checks; no new live V2 transaction was sent.
- **Payment ledger:** SQLite operation ledger with stable logical fingerprints, durable reservations, explicit settled/not-settled/unknown reconciliation, per-operation budget checks, concurrency control, and restart recovery. A configurable Hedera x402 submit/status/output client is implemented. This checkout keeps the local fixture selected because provider endpoints and buyer-owned Arkiv storage settings are absent; production paid execution fails closed.
- **Recovery:** encrypted checkpoint and artifact manifests, enforced artifact/manifest/chunk/read-concurrency bounds, exact accepted-head recovery validation, a buyer-host key service with per-worker tokens and encrypted key transport, a TLS key-grant client, deterministic and Beta-Bernoulli state adapters, and a local A-to-B worker handoff. Worker B CLI commands recover an accepted checkpoint and stream a previously paid output to a downstream consumer after signed reuse. The key service passes a local fixture check; a live accepted-checkpoint grant and B-host topology remain pending.
- **Tools and admission:** MCP discovery/invocation fixtures, candidate capability schema, hard eligibility filtering, plus Worker B-specific authenticated schema discovery and a read-only probe. The real B MCP endpoint and credentials are not configured.

### Verification

The pushed merge candidate `a155b5e` passes `npm run verify`: 117/117 automated tests, client/server typecheck and production builds, Solidity compilation, the signing vector, and local acceptance. `forge test --root server/contracts --offline` passes 17/17. The coverage includes simulated Sepolia writes and confirmations, worker-signed claim relay validation, Worker B environment filtering, recovery after SQLite restart, and x402 challenge-policy fixtures. All provider, chain-write, and Arkiv paths in this verification use fakes or local fixtures; this pass made no Sepolia transaction, Arkiv write, or x402 payment.

### Sepolia progress

D1 reports that Sepolia ENS scoped grant, wrong-job denial, and revoke assertions passed. The historical funded lifecycle for job `cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3` completed 17 successful transactions: A withdrew 3 test tokens, B withdrew 7, takeover reached epoch 2, escrow ended at zero, and stale A rejection was confirmed by simulation. Public receipts are in [the Sepolia job evidence file](evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json). This is the live baseline; the revised V2 escrow ABI has not been deployed or tested live. ENS resolver and BATON adapter remain separate addresses.

### V2 escrow requirements and prepared test

The configured escrow is the historical V1 deployment. The lifecycle runner checks `PROTOCOL_VERSION()` against `keccak256("BATON_JOB_ESCROW_V2")` before creating or funding a job; the configured address does not expose that marker. The V1 17-transaction lifecycle is useful historical evidence but does not exercise these V2 contract changes:

- `MilestoneOffer` now signs the acceptance-spec hash, accepted manifest locator, and checkpoint sequence as well as the head. The contract enforces a nonempty head/locator and the next sequence, and exposes `acceptedCheckpoint(jobId)` for recovery. Offers must be signed for the replacement escrow's EIP-712 domain.
- Reward withdrawals are cumulative: V2 replaces the one-time `claimed` flag with `withdrawnCredits`. It also tracks credited, withdrawn, and refunded totals and exposes `accounting(jobId)`. This is required for a worker to withdraw an earlier milestone and later withdraw newly earned credit.
- V2 adds buyer-only `cancelDrain()` with open-task checks, allowing the buyer policy to reopen A only after reconciliation and confirmed chain state.
- Takeover rejects assigning the current worker as its own successor; expiry, replay, checkpoint-head, and milestone-sequence checks are enforced against the V2 state.

The full 3/3/4-token A-to-B lifecycle is prepared in the local, ignored `.baton-data/prepared-sepolia-v2-test-job.json`. It covers A's first milestone, B acknowledging the exact accepted head and taking over at epoch 2, B's remaining milestones, stale-A rejection, closure, and 3/7 claims. It is a prepared specification, not an on-chain job: the runner stops before job creation/funding while the configured address is V1. It will deploy a fresh test reward token when `BATON_REWARD_TOKEN_ADDRESS` is unset; otherwise the buyer must hold at least 10 test tokens. No replacement escrow has been deployed.

The current API, React client, and buyer key service were already running and returned HTTP 200 on their health routes. `/api/status` reports Sepolia mutations enabled, `contentStore=unconfigured`, and `hederaX402=false`. Therefore the escrow lifecycle job is prepared, while live checkpoint storage, key grant, paid x402 operation, and separate-host B recovery still require their own configured services and evidence.

### Remaining work

- Reuse the running buyer-host key service, grant B the exact live accepted checkpoint, and perform buyer-owned Arkiv write/readback and clean-host recovery. Add a temporary HTTPS tunnel only if B runs on another machine.
- Configure `ARKIV_RPC_URL` and a buyer-controlled `ARKIV_SIGNER_PRIVATE_KEY` privately; confirm Arkiv ownership/renewal.
- Fill B's MCP endpoint/token and safe probe values in `.env.worker-b`; use `npm run worker:tools:b` to discover schemas and `npm run worker:probe:b` for the authenticated, read-only capability probe.
- Supply and confirm the actual paid-service submit/status/output endpoints against the contract in `test.md`; then wire those values privately and verify authoritative settlement, output retrieval, and actual debit.
- Review the V2 contract delta above before replacing the V1 escrow. The ENS resolver and authority adapter are already paired and can be reused. After a replacement is configured, run `npm run demo:sepolia:job-lifecycle` to execute the prepared fresh job; no deployment or lifecycle transaction has been sent.
- Configure the missing buyer-owned Arkiv RPC/signer and the real paid-service submit/status/output endpoints before claiming a live checkpoint or payment proof. Fill B's MCP endpoint/token privately before running `npm run worker:tools:b` and `npm run worker:probe:b`.

## Buyer-side takeover policy

The G5 policy runner is implemented and opt-in. It measures a missed heartbeat only after A has submitted an authenticated heartbeat for the current epoch; no heartbeat means no timeout trigger. After the configured timeout, the runner closes SQLite admissions immediately, waits for active provider submissions to finish, confirms the buyer-only escrow drain, and reconciles every `RESERVED`, `SUBMITTED` or `UNKNOWN` operation. Any unresolved payment keeps the task closed. If A's checkpoint acceptance wins the chain race before the drain, the runner confirms the drain and then fails closed on the stale local head; B must recover and acknowledge the updated accepted head before takeover can continue.

Worker B must recover and validate the confirmed accepted checkpoint with `recoverAcceptedPackage`, then call `submitRecoveredCheckpointAcknowledgement` to sign its exact-head acknowledgement. The API checks B's signature, policy/head/epoch bindings, live grant, and drained/reconciled state. The buyer runner submits `takeover`, waits for the configured Sepolia confirmations, re-reads assignment/epoch and only then reopens under B. Epoch fencing rejects stale A requests. A timeout signals suspicion and does not prove A is dead.

To enable the runner, configure `GATEWAY_AUTHORITY_MODE=sepolia`, Sepolia RPC/escrow/authority values, `WORKER_A_ADDRESS`, `WORKER_B_ADDRESS`, and `SEPOLIA_DEPLOYER_PRIVATE_KEY` in the private root `.env`, then set `TAKEOVER_POLICY_ENABLED=true`. `SEPOLIA_DEPLOYER_PRIVATE_KEY` must derive the buyer address for each job and have Sepolia gas. `BATON_BUYER_EVM_PRIVATE_KEY` remains available for checkpoint-key grant commands. Set `WORKER_HEARTBEAT_TIMEOUT_MS` and `TAKEOVER_POLICY_INTERVAL_MS` for the demo. The default timeout is 60 seconds. Keep the transaction signer separate from `ARKIV_SIGNER_PRIVATE_KEY`; the policy runner is buyer-trusted infrastructure, and contract-enforced succession is future work.

Worker A starts `startWorkerHeartbeatLoop` with an interval shorter than the buyer timeout; it refreshes the job snapshot and signs each `POST /api/jobs/:jobId/heartbeat`. Worker B posts its EIP-712 acknowledgement to `POST /api/jobs/:jobId/takeover-ack` after recovery. A buyer can cancel a drain through the authenticated `POST /api/jobs/:jobId/cancel-drain` path only after pending operations reconcile and the confirmed assignment, head and grant still permit A to resume; the escrow's buyer-only `cancelDrain` call is confirmed before local reopening. Focused local regressions pass, but the configured escrow still needs a reviewed V2 deployment and no G5 transaction has been tested live.

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
server/src/services/takeover/   Buyer-side heartbeat policy and takeover runner
server/src/services/ledger/     SQLite payment-operation ledger
server/contracts/               Solidity escrow, authority adapter and ABIs
server/packages/checkpoint/     Encrypted recovery manifest
server/packages/storage/        Arkiv manifests and encrypted artifact chunks
server/packages/runtime/        Deterministic and quantitative state adapters
server/apps/worker/             Worker CLI, local handoff, and heartbeat/ack client helpers
server/services/                Provider, MCP and candidate-admission adapters
scripts/                        Local scenarios, status refresh and contract checks
status/                         Per-owner progress and gate evidence
```

SQLite settings and current decisions are described in [BATON_Architecture.md](BATON_Architecture.md), [context.md](context.md), and [.env.example](.env.example). The build plan and ownership gates are in [plan.md](plan.md); test modes and live-read evidence are in [docs/gates.md](docs/gates.md).
