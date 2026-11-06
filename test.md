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

`npm test` runs the checkpoint, storage, runtime, worker, tools, admission, SQLite ledger, and HTTP restart suites. `npm run verify` adds typechecking, production builds, Solidity compilation, the signing vector, and local gateway acceptance, including the payment-crash recovery scenario. An earlier revision of the HTTP restart test passed 1/1 on the user's Mac before the job-provisioning journal change. The latest path needs a local rerun: this execution sandbox rejects `listen(127.0.0.1)` with `EPERM`.

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

The current G0–G4 candidate passed this command with 52 tests. That includes buyer-signed/idempotent chain-job import, the signed route-dispatch flow from assignment through payment reconciliation with production mutation gating, buyer-signed accepted-checkpoint key grants with durable replay prevention, a provider-boundary authority recheck that denies payment after revocation, exact encrypted candidate manifest/owner/adapter/parent checks with fake storage, independent RPC common-block/state agreement and disagreement handling, signed-action replay/expiry/binding checks, exact local/on-chain snapshot accounting, offline recovery and key-grant-client fakes, policy-bound operation fingerprints, cross-store job/budget crash recovery, and output-state recovery after a SQLite write failure. Route tests exercise Express middleware and dispatch in-process; they do not exercise a TCP listener, Arkiv network, provider, or Sepolia.

The Solidity suite passes 12/12 with the pinned solc 0.8.28 using an isolated, offline solc-js wrapper because this machine has no Foundry solc cache. On a machine with solc 0.8.28 installed, run `forge test --root server/contracts --offline`. Coverage includes exact-cutoff rejection, sequence and parent validity, buyer-only initial assignment with a job-scoped grant, pause/resume, takeover, repeated withdrawals, closure, refunds, and transfer-failure rollback.

## Gateway authority and payment recovery

`GATEWAY_AUTHORITY_MODE=auto` enables Sepolia checks when the RPC URL, escrow, and BATON adapter addresses are configured. Set it to `sepolia` to require that configuration and fail closed, or `local` for local-only work. The authority reader checks the Sepolia chain, escrow buyer and adapter bindings, current worker and epoch, job open/drain/cutoff state, and the worker's job-scoped grant before accepting a milestone or service request. Local acceptance uses a mock authority reader and does not contact Sepolia.

The `paymentCrash` scenario settles once through a fake provider, leaves the SQLite ledger in `UNKNOWN`, closes and reopens the ledger, then lets authorized B recover A's paid output. It also checks that an unknown result stays reserved and a definitive non-settlement releases once without resubmitting. The `secondCharge: false` result demonstrates local idempotency only; it is not evidence of a live Hedera x402 payment or Arkiv output persistence.

The server loads the checkout root `.env`; inherited process variables take precedence over values loaded by dotenv. Check variable names without displaying values, and restart the API after changing `.env`. The cold-recovery helper requires an exact accepted digest/locator, a supported adapter, storage-owner/expiry checks, and a key grant scoped to worker/job/checkpoint. The buyer root `.env` still lacks `ARKIV_RPC_URL` and `ARKIV_SIGNER_PRIVATE_KEY`. Worker-specific key-service env files are provisioned locally; a grant for a live accepted checkpoint is pending. D2 will confirm whether B runs on another machine; use the public tunnel only for cross-host access.

## Buyer-controlled checkpoint key service

`npm run key-service:provision` creates ignored `.env.key-service`, `.env.worker-a`, and `.env.worker-b` files with mode `0600`. It generates distinct worker bearer tokens and X25519 recipient keys. The SQLite service stores token hashes and encrypts checkpoint keys at rest; each returned key is additionally encrypted to the authorized worker, so a tunnel carries ciphertext rather than the raw decryption key.

`npm run key-service:smoke` verifies B can decrypt a fresh fixture checkpoint with B's provisioned token, A is denied, and B cannot claim A's worker identity. This is a local fixture check, not proof that an on-chain accepted package exists.

Run `npm run key-service:start` on the buyer host as a separate long-lived process; it exposes only `/healthz` and `POST /v1/resolve`. The provisioned URL is loopback for workers on the same laptop. D2 will confirm whether B runs on another machine. If so, run `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4411` separately on the buyer host and set the generated URL with `npm run key-service:set-url -- https://<temporary-host>`. Keep the service alive independently of Worker A. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) are temporary: the URL changes when a new tunnel is created and stops working when the process stops. Anyone who learns the URL can reach the service, while per-worker tokens and encrypted responses control access. The service itself must remain on the buyer-controlled host.

After a real checkpoint is staged and accepted, add only its exact grant with `npm run key-service:grant -- <jobId> <taskId> <manifestDigest> <workerAddress>`. The command reads the buyer signer and checkpoint key from the buyer root `.env` without printing either secret, verifies the signer matches the job buyer, compares the accepted snapshot with confirmed Sepolia state, signs the exact worker/checkpoint/key-ID grant, consumes its nonce in the SQLite ledger, then writes the grant. Set `BATON_BUYER_EVM_PRIVATE_KEY` privately; `SEPOLIA_DEPLOYER_PRIVATE_KEY` is accepted only when it derives the buyer address. Worker processes should load their own ignored file, for example `node --env-file=.env.worker-b --import tsx ...`. No live grant, Arkiv write/read, or key-service request has been performed.

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

The historical live run is recorded in [the Sepolia job evidence file](evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json). It used the earlier escrow ABI and minted/allocated all 10 test tokens. The revised V2 escrow is not deployed; do not rerun the lifecycle against the old escrow. After a reviewed replacement deployment, the runner requires at least 10 reward tokens in the buyer's balance.

Do not use escrow deployment commands as routine tests. They deploy a new contract; the lifecycle workflow must reuse the configured escrow.
