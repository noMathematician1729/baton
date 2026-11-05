# Gate evidence

| Gate | Feature | Mode | State | Base commit / timestamp (UTC) | Evidence | Human check |
|---|---|---|---|---|---|---|
| G0 | Client/server production build and typecheck | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm run typecheck`; `npm run build` | Pending |
| G0 | Checkpoint AES-GCM manifest/chunk crypto | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm test` (checkpoint suite: 4/4); `server/packages/checkpoint/src/` | Pending |
| G0 | Arkiv chunking, delta reuse, and corruption checks | Local simulation | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm test` (storage suite: 2/2, using an in-memory test harness; no live Arkiv writes) | Pending |
| G0 | Deterministic batch and quantitative recovery | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm run demo:local`; `npm test` (runtime: 2/2; worker handoff: 1/1) | Pending |
| G0 | MCP tool conformance and admission filtering | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm test` (tools: 1/1; admission: 1/1) | Pending |
| G1 | SQLite payment-operation ledger | Local | LOCAL_PASS | `1a360d4` working tree · 2026-11-05T19:43Z | `npm run verify`; `npm run test:ledger` (3/3: restart/UNKNOWN, budget conservation, immutable policy, competing reservations) | Pending |
| G1 | D1 authority/payment local acceptance | Local fixture | LOCAL_PASS | `1a360d4` working tree · 2026-11-05T19:43Z | `npm run verify`; `scripts/acceptance-local.mjs` (A/B 3/7 credits, stale-worker rejection, idempotency, UNKNOWN restart without resubmit) | Pending |
| G1 | Solidity compile and signing vector | Local | LOCAL_PASS | `1a360d4` working tree · 2026-11-05T19:43Z | `npm run verify`; solc 0.8.28 compilation and EIP-712 hash/recovery vector | Pending |
| G0 | Integrated client/server build and local suites | Local | LOCAL_PASS | `1a360d4` working tree · 2026-11-05T19:43Z | `npm run verify`; typecheck, production builds, 14 local tests | Pending |
| G0 | Arkiv Rabdi endpoint read | Live read-only | LIVE_PASS | `796151b` · 2026-11-05T17:48Z | Read block number using configured RPC; no content write | Pending |
| G0 | Hedera account lookup | Live read-only | LIVE_PASS | `796151b` · 2026-11-05T17:48Z | Mirror Node account GET returned success; no payment | Pending |
| G0 | Arkiv content write/readback | Live | BLOCKED | `796151b` · 2026-11-05T17:48Z | Encryption key missing/invalid; ownership/renewal policy unresolved; no write attempted | Needs checkpoint key and storage ownership policy |
| G0 | Sepolia escrow and ENS reads | Live | BLOCKED | `796151b` · 2026-11-05T17:48Z | Sepolia RPC, escrow address and resolver address missing | Needs D1 deployment/configuration |
| G0 | Hedera x402 paid operation | Live | BLOCKED | `796151b` · 2026-11-05T17:48Z | No paid request attempted; SQLite ledger/gateway recovery not implemented | Needs ledger integration and explicit paid smoke run |
| G0 | Shared protocol/signing fixture | Local | LOCAL_PASS | `1a360d4` working tree · 2026-11-05T19:43Z | `npm run verify`; merged D1 protocol and deterministic signing vector pass | Pending |

The integrated local checks above ran against the working tree on `build/runtime-recovery`, based on `1a360d4`; all 14 local tests, contract compilation, signing recovery, and D1 acceptance passed. The prior Arkiv and Hedera read-only probes passed; no Arkiv content write, x402 payment, Sepolia transaction or ENS authority check was performed. Dependency installation reported two advisories (one high severity); they remain unreviewed.
