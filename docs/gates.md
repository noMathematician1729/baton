# Gate evidence

| Gate | Feature | Mode | State | Base commit / timestamp (UTC) | Evidence | Human check |
|---|---|---|---|---|---|---|
| G0 | Client/server production build and typecheck | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm run typecheck`; `npm run build` | Pending |
| G0 | Checkpoint AES-GCM manifest/chunk crypto | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm test` (checkpoint suite: 4/4); `server/packages/checkpoint/src/` | Pending |
| G0 | Arkiv chunking, delta reuse, and corruption checks | Local simulation | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm test` (storage suite: 2/2, using an in-memory test harness; no live Arkiv writes) | Pending |
| G0 | Deterministic batch and quantitative recovery | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm run demo:local`; `npm test` (runtime: 2/2; worker handoff: 1/1) | Pending |
| G0 | MCP tool conformance and admission filtering | Local | LOCAL_PASS | `796151b` · 2026-11-05T17:50Z | `npm test` (tools: 1/1; admission: 1/1) | Pending |
| G1 | Payment-operation ledger backend selection | Design | BUILDING | `796151b` · 2026-11-05T17:50Z | User decision: SQLite; architecture and env config updated; transactional ledger code not implemented | Pending |
| G0 | Arkiv Rabdi endpoint read | Live read-only | LIVE_PASS | `796151b` · 2026-11-05T17:48Z | Read block number using configured RPC; no content write | Pending |
| G0 | Hedera account lookup | Live read-only | LIVE_PASS | `796151b` · 2026-11-05T17:48Z | Mirror Node account GET returned success; no payment | Pending |
| G0 | Arkiv content write/readback | Live | BLOCKED | `796151b` · 2026-11-05T17:48Z | Encryption key missing/invalid; ownership/renewal policy unresolved; no write attempted | Needs checkpoint key and storage ownership policy |
| G0 | Sepolia escrow and ENS reads | Live | BLOCKED | `796151b` · 2026-11-05T17:48Z | Sepolia RPC, escrow address and resolver address missing | Needs D1 deployment/configuration |
| G0 | Hedera x402 paid operation | Live | BLOCKED | `796151b` · 2026-11-05T17:48Z | No paid request attempted; SQLite ledger/gateway recovery not implemented | Needs ledger integration and explicit paid smoke run |
| G0 | Shared protocol/signing fixture | Local | BLOCKED | `796151b` · 2026-11-05T17:48Z | No D1 status file or local `build/authority-payments` branch; D1 reported not ready | Needs D1 interface publication |

The base commit is `796151b`; the listed checks were run against the uncommitted working tree on `build/runtime-recovery`. The local suite totals 11 passing tests. Arkiv and Hedera read-only probes passed; no Arkiv content write, x402 payment, Sepolia transaction or ENS authority check was performed.
