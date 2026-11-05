# Gate evidence

| Gate | Feature | Mode | State | Base commit / timestamp (UTC) | Evidence | Human check |
|---|---|---|---|---|---|---|
| G0 | Client/server production build and typecheck | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm run typecheck`; `npm run build` | Pending |
| G0 | Checkpoint AES-GCM manifest/chunk crypto | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm test` (checkpoint suite: 4/4); `server/packages/checkpoint/src/` | Pending |
| G0 | Arkiv chunking, delta reuse, and corruption checks | Local simulation | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm test` (storage suite: 2/2, using an in-memory test harness; no live Arkiv writes) | Pending |
| G0 | Deterministic batch and quantitative recovery | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm run demo:local`; `npm test` (runtime: 2/2; worker handoff: 1/1) | Pending |
| G0 | MCP tool conformance and admission filtering | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm test` (tools: 1/1; admission: 1/1) | Pending |
| G1 | SQLite payment-operation ledger | Local | LOCAL_PASS | `962ccf1` working tree · 2026-11-05T19:55Z | `npm run verify`; `npm run test:ledger` (3/3: restart/UNKNOWN, budget conservation, immutable policy, competing reservations) | Pending |
| G1 | Payment API and ledger restart integration | Local HTTP | LOCAL_PASS | `962ccf1` working tree · 2026-11-05T19:55Z | `npm run test:api` creates a job, executes a local fixture payment, restarts the app, and reads job/operation/balance from persisted JSON and SQLite paths | Pending |
| G1 | D1 authority/payment local acceptance | Local fixture | LOCAL_PASS | `962ccf1` working tree · 2026-11-05T19:55Z | `npm run verify`; `scripts/acceptance-local.mjs` (A/B 3/7 credits, stale-worker rejection, idempotency, UNKNOWN restart without resubmit) | Pending |
| G1 | Solidity compile and signing vector | Local | LOCAL_PASS | `962ccf1` working tree · 2026-11-05T19:55Z | `npm run verify`; solc 0.8.28 compilation and EIP-712 hash/recovery vector | Pending |
| G0 | Integrated client/server build and local suites | Local | LOCAL_PASS | `962ccf1` working tree · 2026-11-05T19:55Z | `npm run verify`; typecheck, production builds, 15 local tests | Pending |
| G0 | Arkiv Rabdi endpoint read | Live read-only | LIVE_PASS | `796151b` · 2026-11-05T17:48Z | Read block number using configured RPC; no content write | Pending |
| G0 | Hedera account lookup | Live read-only | LIVE_PASS | `796151b` · 2026-11-05T17:48Z | Mirror Node account GET returned success; no payment | Pending |
| G0 | Arkiv content write/readback | Live | BLOCKED | `.env` shape check · 2026-11-06 | `ARKIV_ACCESS_KEY` is missing; no content write/readback attempted; ownership/renewal policy unresolved | Set the access key privately, define ownership/renewal authority, then run a live encrypted write/readback |
| G0 | ENS scoped grant and authority checks | Live Sepolia | LIVE_PASS | D1-reported live check · 2026-11-06 | ENS grant → authorized, wrong job → unauthorized, revoke → unauthorized; real ENS resolver address is separate from BATON's adapter address | Preserve this as live authority evidence; rerun only after contract/config changes |
| G0 | Funded Sepolia A-to-B job lifecycle | Live Sepolia | LIVE_PASS | D1 live run · 2026-11-06 | 17 confirmed transactions; A withdrew 3 test tokens, B withdrew 7, takeover reached epoch 2, escrow token balance ended at zero; stale A rejected by simulation | [Public transaction evidence](../evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json) |
| G0 | Hedera x402 paid operation | Live | BLOCKED | `.env` shape check · 2026-11-05T20:02Z | Hedera account/key/facilitator settings are present; app still uses the local payment fixture; no paid request attempted | Integrate a real provider and explicitly authorize one test payment |
| G0 | Shared protocol/signing fixture | Local | LOCAL_PASS | `962ccf1` working tree · 2026-11-05T19:55Z | `npm run verify`; merged D1 protocol and deterministic signing vector pass | Pending |

The recorded local checks ran against an earlier combined tree on `build/runtime-recovery`; the current merge resolution has not yet been rerun through `npm run verify`. The live Sepolia authority and lifecycle results above are D1's recorded live results and are distinct from local simulations. No Arkiv content write or x402 payment has been made. `npm audit` reports one high and one low issue through the development compiler chain; see `requests.md` for the proposed dry-run upgrade.
