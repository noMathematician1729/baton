# Testing commands

Use Node.js 22.12+ and npm 10+. Keep RPC endpoints and signer keys in the ignored local `.env`; never put secret values in `test.md`, logs, or chat.

## Local checks

These commands build or test locally and do not send Sepolia transactions:

```sh
npm run typecheck
npm run build
npm run contracts:compile
npm run test:signing
npm run test:local
npm run verify
```

`npm run verify` runs typechecking, production builds, Solidity compilation, the signing vector, and the local acceptance scenario. Run it as the normal pre-push check.

## Gateway authority and payment recovery

`GATEWAY_AUTHORITY_MODE=auto` enables the Sepolia reader when the RPC, escrow, and BATON adapter addresses are configured. Set it to `sepolia` to require that configuration and fail closed, or `local` for local-only work. The reader checks Sepolia chain ID, escrow buyer and adapter bindings, current worker and epoch, job open/drain/cutoff state, and the worker's job-scoped grant before the gateway accepts a milestone or sends a service request. The local suite uses a mock reader to verify stale/revoked-worker rejection and per-request caps; it does not contact Sepolia.

The `paymentCrash` scenario settles once through a fake provider, leaves the ledger in `UNKNOWN`, recreates the gateway and stores from disk, then lets authorized B recover the same output. Its `secondCharge: false` result is a local idempotency assertion, not evidence of a live Hedera x402 payment. The current API still uses `LocalPaymentProvider` until the D2 provider and durable ledger are integrated.

The server loads the checkout root `.env` from `server/src/config/env.ts`. `dotenv` does not override variables already inherited by the process, so stale `ARKIV_*` or worker-specific values in the launching shell take precedence. Check variable names only; never print values. Restart the API after changing `.env`.

## Sepolia checks

These use `.env` signers and send on-chain transactions. They consume Sepolia gas and should be run deliberately:

```sh
npm run test:sepolia:authority
npm run test:sepolia:worker-grants
npm run demo:sepolia:job-lifecycle
```

- `test:sepolia:authority` checks the live ENS resolver and scoped grant/revoke behavior. It can deploy the BATON adapter if no adapter address is configured.
- `test:sepolia:worker-grants` temporarily grants and revokes job-scoped resolver permissions for the configured Worker A and Worker B addresses.
- `demo:sepolia:job-lifecycle` reuses `BATON_ESCROW_ADDRESS`; it does not deploy or replace the escrow. If no reward token is configured, it deploys the test-only `BatonTestToken`. It funds a 3/3/4 milestone job, performs the A-to-B handoff, checks stale A rejection with `eth_call`, closes the job, and verifies both claims. It writes public transaction evidence to `evidence/sepolia-jobs/`.

The completed live run is recorded in [the Sepolia job evidence file](evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json). That run minted and allocated all 10 test tokens. Re-running the lifecycle command requires at least 10 tokens in the buyer's balance because the runner does not remint an already configured reward token.

Do not use escrow deployment commands as routine tests. They deploy a new contract; the lifecycle workflow must reuse the configured escrow.
