# Testing commands

Use Node.js 22.13+ and npm 10+. Keep RPC endpoints and signer keys in the ignored local `.env`; never put secret values in this file, logs, or chat.

## Local checks

These commands build or test locally and do not send Sepolia transactions:

```sh
npm run typecheck
npm run build
npm run contracts:compile
npm test
npm run test:signing
npm run test:local
npm run verify
```

`npm test` runs the checkpoint, storage, runtime, worker, tools, admission, SQLite ledger, and HTTP restart suites. `npm run verify` adds typechecking, production builds, Solidity compilation, the signing vector, and local gateway acceptance, including the payment-crash recovery scenario. The latest HTTP restart test passes 1/1 on this checkout with `node --import tsx --test server/src/app.integration.test.ts`.

Worker B MCP access is isolated to `.env.worker-b`. Once B has its service endpoint and token, `npm run worker:tools:b` lists tool names, advertised input/output schemas, schema versions and schema digests without invoking a tool. Fill the expected values and a documented read-only probe input in `.env.worker-b`, then run `npm run worker:probe:b`. The probe refuses tools not marked read-only and checks the server identity, version, exact input/output schema digest and expected output digest. The actual B endpoint/credential and probe input are currently absent; the local synthetic MCP tests do not establish B's live entitlement.

For offline suites in this sandbox, bypass the `tsx --test` IPC launcher and run the source tests directly. This includes Express route dispatch with in-memory requests and responses; it does not bind a TCP listener:

```sh
node --import tsx --test \
  server/packages/*/src/*.test.ts \
  server/apps/worker/src/*.test.ts \
  server/services/*/*.test.ts \
  server/src/app.routes.test.ts \
  server/src/domain/jobs/*.test.ts \
  server/src/chain/*.test.ts \
  server/src/services/*/*.test.ts
```

Before the G5 policy edits, the G0–G4 candidate passed this command with 52 tests. That includes buyer-signed/idempotent chain-job import, the signed route-dispatch flow from assignment through payment reconciliation with production mutation gating, buyer-signed accepted-checkpoint key grants with durable replay prevention, a provider-boundary authority recheck that denies payment after revocation, exact encrypted candidate manifest/owner/adapter/parent checks with fake storage, independent RPC common-block/state agreement and disagreement handling, signed-action replay/expiry/binding checks, exact local/on-chain snapshot accounting, offline recovery and key-grant-client fakes, policy-bound operation fingerprints, cross-store job/budget crash recovery, and output-state recovery after a SQLite write failure. Route tests exercise Express middleware and dispatch in-process; they do not exercise a TCP listener, Arkiv network, provider, or Sepolia.

The G5 buyer-side policy runner, signed heartbeat/ack routes, transaction writer, and confirmed accepted-head refresh were added after that 52-test run. Focused current-tree regressions pass with:

```sh
node --import tsx --test \
  server/src/services/gateway/checkpointCandidateVerifier.test.ts \
  server/src/services/gateway/gateway.test.ts \
  server/src/services/takeover/buyerTakeoverPolicy.test.ts \
  server/src/app.routes.test.ts
```

The command passed 16/16 tests, covering signed production route gating, uncertain-payment cancellation, no reconciliation while a task is running, buyer-signed drain cancellation, stale A spending, failed takeover across a ledger restart, exact accepted-checkpoint recovery after the acceptance-before-drain race, and B's fresh acknowledgement. The storage suite passes 12/12, including the shared encrypted boundary fixture's digest, locator, EIP-712 signing, and recovery checks. Foundry passes 17/17 with solc 0.8.28 using `forge test --root server/contracts --offline`; the shared fixture is also accepted by the escrow test, which checks the committed head and locator. These are local/fake-backed checks; no G5 transaction or live B grant was tested. The runner is disabled by default and requires the job buyer's Sepolia key, configured A/B addresses and a live B grant. A heartbeat timeout is only a suspicion trigger. The runner drains the buyer-only escrow, reconciles pending operations, waits for B's accepted-head acknowledgement, submits takeover, confirms the chain state, then reopens.

The earlier 12/12 and 16/16 Solidity results are historical. The current suite passes 17/17 with pinned solc 0.8.28 using `forge test --root server/contracts --offline`.

## Two worker runtimes: connect, run, take over, recover

This is the A→B handoff through the normal application path: configured Codex or Gemma/ADK runtimes, ENSv2 on Sepolia, encrypted Arkiv checkpoints and the V2 escrow. Every command below is a real testnet action unless marked otherwise. Hedera x402 and automatic failure detection are not part of this path. The managed-worker CLI flow assumes the API and workers share a host; Gemma workers can instead run on the Ollama host as described in `server/apps/worker-adk/README.md`.

### Identity mapping

Each mapping is explicit and independent. Query it with `npm run baton -- status <jobId>`.

| Concept | Where it lives | Example |
|---|---|---|
| Stable worker ID | Registry, `.env.worker-<id>` | `a`, `b` |
| LLM runtime | worker record and private worker home | Codex app-server or Google ADK with local Ollama/Gemma |
| Worker wallet | `WORKER_EVM_PRIVATE_KEY` in `.env.worker-<id>`; ownership proven by signature at registration | `0x432E…A5D2` |
| ENS name | Per-job child name, buyer-owned | `a.job-<id>.baton.eth` |
| Authority | Escrow `assignedWorker` and `epoch` on Sepolia | ENS is discovery, not authority |

### Configuration

Variable names only; values stay in ignored files.

- Root `.env` (buyer host): `SEPOLIA_RPC_URL`, `SEPOLIA_DEPLOYER_PRIVATE_KEY` (buyer), `BATON_ESCROW_ADDRESS`, `BATON_REWARD_TOKEN_ADDRESS`, `ENS_JOB_NAME` (parent), `CHECKPOINT_ENCRYPTION_KEY` (key-encryption key for per-epoch content keys), `ARKIV_ACCESS_KEY` (optionally `ARKIV_ACCESS_KEY_A` for worker A), `ARKIV_RPC_URL_A`, `ARKIV_RPC_URL_B`, `ARKIV_SIGNER_PRIVATE_KEY_A`, `ARKIV_SIGNER_PRIVATE_KEY_B`, `WORKER_A_EVM_PRIVATE_KEY`, `WORKER_B_EVM_PRIVATE_KEY`, `BATON_CORE_ENABLED`, `BATON_BUYER_API_TOKEN`.
- `.env.key-service`: created by `npm run key-service:provision`.
- `.env.worker-<id>`: created by `key-service:provision`, completed by `core:setup`. Holds only that worker's own wallet, Arkiv signer and key-service credentials. The API launches workers with a clean environment, so buyer secrets are not inherited.
- Optional: `BATON_CODEX_MODEL` (worker env; defaults to the account's Codex default), `BATON_CORE_CONFIRMATIONS` (default 2).

### Setup (once)

```sh
npm ci --ignore-scripts
npm run key-service:provision   # only if the .env.worker-* files do not exist
npm run deploy:sepolia:escrow:replace   # only when replacing a non-V2 escrow; sends a transaction
npm run core:setup              # verifies the V2 marker, deploys the test token if unset, fills worker env files
```

### Start services

Run each in its own terminal. They are independent, so stopping a worker never stops them.

```sh
npm run key-service:start
npm run core:api
```

### Connect each worker (once per account)

```sh
npm run baton -- connect a
npm run baton -- connect b --no-open
```

For Codex workers, `connect` starts the runtime and prints the official OpenAI sign-in link when needed. Sign in to a different account for each worker; use `--no-open` for B and open the link in a private window. Never paste credentials anywhere; the sign-in completes in the browser and returns to the worker's localhost callback. For Gemma workers, set the `BATON_WORKER_RUNTIME=adk` settings and start each worker on the Ollama host using the ADK guide; no Codex sign-in is needed.

A worker becomes `available` only after its new process passes the connect smoke test. Codex must pass its OS sandbox isolation probe; ADK must prove Gemma inference and the workspace-scoped function tool boundary. Check with `npm run baton -- workers`.

### Run a job

```sh
npm run baton -- submit                          # BATON picks an available verified worker
npm run baton -- wait <jobId> ready              # ENS, keys, funding, assignment and mapping verified
npm run baton -- wait <jobId> verified:1         # worker checkpointed; buyer read it back from Arkiv and checked it
npm run baton -- accept <jobId> 1                # buyer approval sends acceptMilestone; the worker then withdraws
npm run baton -- activity a                      # the worker's recent activity
```

The buyer always approves milestones explicitly; a worker cannot approve its own reward.

### Replace a failed worker

```sh
npm run baton -- stop a                  # kills A's process group; the job, its namespace and B are unaffected
npm run baton -- takeover <jobId> b      # omit the worker ID to let BATON choose
npm run baton -- wait <jobId> takeover-done
```

Takeover drains the job, registers `b.job-<id>.baton.eth`, grants B's job-scoped ENS role, and collects B's signed acknowledgement of the exact on-chain head. It then submits the takeover, revokes A's ENS grant and key-service grants, issues B a new epoch key and a recovery grant for the exact accepted checkpoint, updates ENS records, and verifies every link before B may work.

B then reads the head from the escrow, fetches that exact Arkiv entity, decrypts and validates it, restores the outputs into its own empty workspace, and continues. It uses no state from A's thread, process or workspace. The accepted checkpoint from A's earlier epoch stays valid after takeover.

Finish with `wait <jobId> verified:2`, `accept <jobId> 2`, `wait <jobId> verified:3`, `accept <jobId> 3`, `wait <jobId> completed`, then `reconcile <jobId>`.

### Run and verify end to end

```sh
npm run core:e2e               # one fresh job, recorded under evidence/core-runs/
npm run core:e2e -- --drill    # also SIGKILLs and restarts the API while a takeover transaction is in flight
node --env-file=.env.worker-a --import tsx scripts/core/stale-check.ts <jobId>   # simulations and refused requests only
node --env-file=.env.worker-b --import tsx scripts/core/arkiv-retention-check.ts <entityKey>   # sends one Arkiv extension
npm run test:core --workspace=server   # offline
```

`core:e2e` needs both workers connected and runs on the buyer host with their API-managed processes. It reconnects nothing, so connect A again before the next job: it deliberately terminates A. A run reports PASS only if payouts reconcile and its assertions hold: A wrote milestone 1 at epoch 1, B wrote 2 and 3 at epoch 2, B recovered A's checkpoint and did not regenerate A's outputs, both runtimes did real tool work, the worker wallets differ, and each runtime's smoke-verified tool boundary passes. ADK's workspace tool boundary is not an OS-level sandbox.

### Partial failures and recovery

- **Blocked job:** `lastError` shows the cause in `status`. The supervisor retries every 30 seconds; `npm run baton -- retry <jobId>` retries now.
- **Crash or restart:** restart the API. The state in `.baton-data/core/core-state.json` is reloaded and non-terminal jobs resume. Sepolia writes are signed and journaled before broadcast, so a retry reconciles the recorded transaction by receipt, or rebroadcasts identical bytes, rather than sending a new one. Do not edit this file by hand. Transactions on different networks are not atomic; each step is journaled separately.
- **Rejected milestone:** the worker receives the failed checks and must fix and resubmit. Nothing is credited.
- **Worker failure:** a failed run retries after 60 seconds. A worker's earned credit survives and is claimed by a periodic sweep after restart.
- **Slow Sepolia RPC:** load-balanced nodes can lag behind a confirmed block, so simulations and claims retry before failing.

### Worker isolation

`sandbox_mode = workspace-write` blocks writes outside the workspace but **allows reading the whole disk**, including the buyer `.env` and other workers' credentials. Workers therefore use the `baton_worker` allow-list profile: read access to system paths, write access to the workspace and a private temp directory, no network, and a private `HOME` so the host user's skills are not discovered. It is verified each time a worker connects, by `codex sandbox -P baton_worker` probes with positive controls and by checking the output of a command the model runs in its own turn.

Limits:
- This is process sandboxing on one shared host, not separate machines or OS users.
- The MCP tool bridge and worker daemon run outside the sandbox by design; the bridge holds no secrets.
- `/opt/homebrew` and `/Library/Developer` are readable for tooling.
- Arkiv entity owners are worker wallets. Entities use permissionless extension, so anyone can renew them after a worker disappears.
- Buyer read routes under `GET /api/core/*` require `x-baton-buyer-token`; the browser console keeps that token in tab memory. Worker-context reads use the worker's signed request. Keep `BATON_BUYER_API_TOKEN` private and set the deployed frontend's `VITE_API_URL` and API `CLIENT_ORIGIN` to the deployed URLs.

## Gateway authority and payment recovery

`GATEWAY_AUTHORITY_MODE=auto` enables Sepolia checks when the RPC URL, escrow, and BATON adapter addresses are configured. Set it to `sepolia` to require that configuration and fail closed, or `local` for local-only work. The authority reader checks the Sepolia chain, escrow buyer and adapter bindings, current worker and epoch, job open/drain/cutoff state, and the worker's job-scoped grant before accepting a milestone or service request. Local acceptance uses a mock authority reader and does not contact Sepolia.

The `paymentCrash` scenario settles once through a fake provider, leaves the SQLite ledger in `UNKNOWN`, closes and reopens the ledger, then lets authorized B reuse the operation and retrieve A's original 30 output bytes. It verifies their SHA-256 digest and one provider submission; an unknown result stays reserved and a definitive non-settlement releases once without resubmitting. This demonstrates the local recovery contract only, not a live Hedera x402 payment or Arkiv output persistence.

The worker recovery suite now includes the clean-host command boundary: it compares the confirmed chain head to the API snapshot, reads the accepted package with read-only Arkiv access, imports the supported runtime, then submits B's acknowledgement. It also checks B's signed discovery, reuse and byte retrieval for an output-ready operation, verifies the returned SHA-256 digest, and confirms that retrieval makes no second provider submission. The x402 provider suite validates the v2 network, asset, payee, exact scheme, fee payer, amount ceiling and settlement header before recording a receipt. Paid bytes are encrypted through Arkiv and read back by an operation-bound digest pointer. The ledger records actual settlement below the reserved maximum and releases the remainder; drain remains blocked while a settled operation lacks output. These added checks use local fakes and do not demonstrate a live provider, Arkiv write, or payment.

After B becomes the confirmed assigned worker, `npm run worker:paid-output:b -- <jobId> <operationId>` paginates the buyer ledger, signs reuse, retrieves the already-paid bytes, and checks their size, operation binding and digest. It writes the raw bytes to stdout for a downstream worker process; the operation ID, original producer/epoch, digest and byte count go to stderr. Set `BATON_API_URL` in `.env.worker-b` to the buyer API's HTTPS URL when B is on another host. Do not pipe raw output into a terminal; connect stdout directly to the task consumer or an explicitly managed workspace.

`HederaPaidServiceHttpClient` implements the gateway's configurable paid-service contract. `HEDERA_PAID_SERVICE_URL` accepts an x402 v2 POST of the bounded input bytes and stable `Idempotency-Key` / `X-Baton-Operation-Id` / `X-Baton-Input-Digest` headers. The service must deduplicate submissions by operation ID. `HEDERA_PAID_STATUS_URL_TEMPLATE` receives GET requests with `{operationId}` URL-encoded; status JSON is either `{ "status": "settled", "providerReceipt": "...", "settledAmount": "...", "outputDigest": "0x..." }`, `{ "status": "not-settled" }` only for a definitive terminal no-charge result, or another status for pending/unknown. Errors, 404s, malformed responses and pending statuses remain `unknown`, so the reservation is held. `HEDERA_PAID_OUTPUT_URL_TEMPLATE` receives the same operation ID and must return raw output bytes plus an exact `X-Baton-Operation-Id` response header. Every status response is capped at 16 KiB; output is bounded by the encrypted artifact limit and digest-checked before Arkiv storage. An optional bearer token is sent to all three endpoints.

The API wires this adapter only when the Hedera payer, all three provider URLs, Arkiv access key, buyer-owned Arkiv signer and checkpoint encryption key are configured. Until then it reports/uses the local fixture; production rejects paid execution with `LIVE_PAYMENT_PROVIDER_REQUIRED`. The current `.env` lacks the three paid-service URLs and the generic buyer-owned Arkiv signer/RPC, so this is a tested adapter contract, not a compatible/live provider integration.

The server loads the checkout root `.env`; inherited process variables take precedence over values loaded by dotenv. Check variable names without displaying values, and restart the API after changing `.env`. The cold-recovery helper requires an exact accepted digest/locator, a supported adapter, storage-owner/expiry checks, and a key grant scoped to worker/job/checkpoint. The buyer root `.env` still lacks `ARKIV_RPC_URL` and `ARKIV_SIGNER_PRIVATE_KEY`. Worker-specific key-service env files are provisioned locally; a grant for a live accepted checkpoint is pending. D2 will confirm whether B runs on another machine; use the public tunnel only for cross-host access.

`SepoliaEscrowWriter` simulates buyer escrow writes, waits for configured confirmations, and rejects the wrong chain or buyer. The worker claim route accepts a signed raw transaction only after binding its hash to the worker's signed API action; the writer verifies the Sepolia chain ID, escrow address, exact `claim(jobId)` calldata, zero value, and recovered worker before relay. `npm run test:authority --workspace=server` includes fake transaction-client coverage. These checks do not submit a live transaction, and the currently configured escrow remains V1.

## Buyer-controlled checkpoint key service

`npm run key-service:provision` creates ignored `.env.key-service`, `.env.worker-a`, and `.env.worker-b` files with mode `0600`. It generates distinct worker bearer tokens and X25519 recipient keys. The SQLite service stores token hashes and encrypts checkpoint keys at rest; each returned key is additionally encrypted to the authorized worker, so a tunnel carries ciphertext rather than the raw decryption key.

`npm run key-service:smoke` verifies B can decrypt a fresh fixture checkpoint with B's provisioned token, A is denied, and B cannot claim A's worker identity. This is a local fixture check, not proof that an on-chain accepted package exists.

Run `npm run key-service:start` on the buyer host as a separate long-lived process; it exposes only `/healthz` and `POST /v1/resolve`. The provisioned URL is loopback for workers on the same laptop. D2 will confirm whether B runs on another machine. If so, run `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4411` separately on the buyer host and set the generated URL with `npm run key-service:set-url -- https://<temporary-host>`. Keep the service alive independently of Worker A. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) are temporary: the URL changes when a new tunnel is created and stops working when the process stops. Anyone who learns the URL can reach the service, while per-worker tokens and encrypted responses control access. The service itself must remain on the buyer-controlled host.

After a real checkpoint is staged and accepted, add only its exact grant with `npm run key-service:grant -- <jobId> <taskId> <manifestDigest> <workerAddress>`. The command reads the buyer signer and checkpoint key from the buyer root `.env` without printing either secret, verifies the signer matches the job buyer, compares the accepted snapshot with confirmed Sepolia state, signs the exact worker/checkpoint/key-ID grant, consumes its nonce in the SQLite ledger, then writes the grant. `SEPOLIA_DEPLOYER_PRIVATE_KEY` is accepted when it derives to the buyer address. Worker processes should load their own ignored file, for example `node --env-file=.env.worker-b --import tsx ...`. The buyer-host service currently answers `/healthz` on loopback; no live checkpoint grant, key-resolution request, or Arkiv write/read has been performed.

The key-grant client sends `{jobId, taskId, manifestDigest, keyId, worker}` with the worker's bearer token, checks every returned binding, and decrypts the X25519-wrapped key locally. Missing, mismatched, or unauthorized grants fail closed.

## Sepolia checks

These use `.env` signers and send on-chain transactions. They consume Sepolia gas and should be run deliberately:

```sh
npm run test:sepolia:authority
npm run test:sepolia:worker-grants
npm run demo:sepolia:job-lifecycle
```

- `test:sepolia:authority` checks the live ENS resolver and scoped grant/revoke behavior. It can deploy the BATON adapter if no adapter address is configured.
- `test:sepolia:worker-grants` temporarily grants and revokes job-scoped resolver permissions for the configured Worker A and Worker B addresses.
- `demo:sepolia:job-lifecycle` reuses `BATON_ESCROW_ADDRESS`; it does not deploy or replace the escrow. It checks for the revised V2 ABI before sending transactions. If no reward token is configured, it deploys the test-only `BatonTestToken`. It funds a 3/3/4 milestone job, performs the A-to-B handoff, checks stale A rejection with `eth_call`, closes the job, and verifies both claims. It writes public transaction evidence to `evidence/sepolia-jobs/`.

The historical live run is recorded in [the Sepolia job evidence file](evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json). It used the earlier escrow ABI and minted/allocated all 10 test tokens. The revised V2 escrow is not deployed; do not rerun the lifecycle against the old escrow. After a reviewed replacement deployment, the runner deploys and mints a fresh test token when `BATON_REWARD_TOKEN_ADDRESS` is unset. If a token address is configured, the buyer must hold at least 10 tokens.

Do not use escrow deployment commands as routine tests. They deploy a new contract; the lifecycle workflow must reuse the configured escrow.
