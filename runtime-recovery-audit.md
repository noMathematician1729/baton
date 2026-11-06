# Runtime recovery audit and next four hours

Audited 6 November 2026 (India time). Repository: `ashwera/baton`.

**Result: the local components work, but BATON's required live recovery flow is not connected end to end. Two contract defects must be resolved before using a new escrow for the integrated demonstration.** Passing the current suites does not establish recovery after a real payment or a real worker failure.

## Audited revision and verification

| Item | Evidence / result |
|---|---|
| Checked-out branch | `build/runtime-recovery`, `49394afc0a431d3ce266b68e93fb4425aeadd00e` |
| D1 comparison | `build/authority-payments`, `e1d7b2c675dfe4bb395f17a1434487588e86684a` |
| Runtime | Node 24.22.1, npm 11.9.0; clean `npm ci --ignore-scripts` |
| Client/server typechecks and production builds | PASS, through `npm run verify` before its test launcher failed |
| Existing tests | 15/15 PASS: 14 checkpoint/storage/runtime/worker/tools/admission/SQLite tests plus 1 HTTP restart test |
| Solidity compilation | PASS with solc `0.8.28+commit.7893614a`, repository Cancun settings |
| Signing vector | PASS: expected hash and recovered signer match |
| Existing local acceptance | PASS: A/B 3/7, stale-worker rejection, same-worker idempotency and UNKNOWN reservation retained after restart |
| Focused audit diagnostics | 9 runtime observations and 2 contract defects confirmed; see attached probe scripts/results |
| Dependency audit | 1 high and 1 low advisory, through development compiler dependencies `solc` / `tmp` |
| Live networks and separate hosts | Not rerun: this checkout has no configured `.env`, payment endpoint or second host |

The exact `npm run verify` command stopped at `tsx --test`: its CLI attempted a Unix socket under `/tmp/tsx-0`, which this environment forbids. Running the same test sources with `node --import tsx --test` worked, including the actual HTTP integration test. Compilation, signing and acceptance were then run separately. This is an environment launcher restriction, not a reported application test failure. Do not label the exact wrapper command as passing here.

The local EVM probes used the unchanged escrow source, solc 0.8.28 with Cancun output, mock authority and an exact-transfer mock token. Ganache's chain mode was Shanghai; the exercised paths succeeded without unsupported instructions. These are focused behavioral reproductions, not a complete Cancun or deployed-bytecode validation. No live transaction, grant, content write or payment was made during this audit.

## Where the flow currently stops

| Required step | Present implementation | Remaining connection |
|---|---|---|
| Fund, assign and accept | Local JSON JobStore, Solidity source, typed signature helpers | API is fixture-only; chain-backed job identity/head reader is absent on this branch |
| Paid batch | Gateway and durable SQLite reservations | Gateway always receives `LocalPaymentProvider`; Hedera fetch helper is unused |
| Persist paid output | Receipt, digest and URI metadata | No output bytes are encrypted, uploaded or read back before `OUTPUT_AVAILABLE` |
| Stage accepted recovery package | AES-GCM and Arkiv manifest/chunk adapter | No worker/acceptance coordinator calls the adapter; acceptance does not read required artifacts |
| Kill A and recover B | One-process `demo-local` encrypts/decrypts in memory | No cold recovery command that reads the confirmed on-chain head and fetches Arkiv content |
| Admit and authorize B | Standalone capability ranking and synthetic MCP probe | Not connected to takeover, private key access or worker-specific live tool access |
| Drain and take over | Local flags and signed Solidity acknowledgement | No pending-operation barrier, confirmed-state bridge or authenticated gateway control plane |
| Show and claim rewards | Local fixture credits; contract implementation | Contract repeated-claim bug; UI is a landing/status page without lifecycle controls |

There are two independent local demonstrations: checkpoint continuation in `server/apps/worker/src/localDemo.ts` and simulated money/authority in `scripts/acceptance-local.mjs`. Neither proves the other component was used. The D1 Sepolia runner also precomputes synthetic checkpoint heads; it does not prove recovery from a newly written Arkiv checkpoint.

## Findings in priority order

### F01 — P0: a worker's second withdrawal is permanently blocked

Source: [JobEscrow.sol](../server/contracts/src/JobEscrow.sol), lines 99 and 230–235.

`claimed[jobId][worker]` is a boolean. Once set, `claim()` computes zero even if subsequent milestones add new credits. Reproduction: accept reward 3 → claim 3 → accept reward 4 for the same worker → the second claim reverts `NothingToClaim`. Credits are 7, withdrawn balance is 3, escrow still holds 4. Closing does not repair it because those rewards are already allocated.

The A=3/B=7 happy path hides the defect by letting each worker claim only once. The escrow source is identical on both branches, so merging D1 does not fix it.

**Repair:** track cumulative withdrawn amounts, or keep a withdrawable credit balance plus separate lifetime totals. Update accounting before transfer. Add claim→earn→claim, claim after handoff/closure, and double-claim regressions. The escrow is non-upgradeable: a repaired source requires a newly reviewed deployment for future jobs; the existing live evidence cannot certify the replacement.

### F02 — P0: the checkpoint head is confused with the acceptance specification

Source: [JobEscrow.sol](../server/contracts/src/JobEscrow.sol), lines 116–131 and 168–172; [jobStore.ts](../server/src/domain/jobs/jobStore.ts), lines 150–153.

At funding, each milestone stores `acceptanceSpecHash`. At acceptance, Solidity requires that hash to equal `offer.newHead`. A correct runtime-generated encrypted manifest therefore cannot become the accepted head unless its exact digest was already supplied at funding. Fresh encryption uses random nonces; its future ciphertext hash is not the acceptance rule hash. The local JobStore instead compares the rule hash to `artifactManifestDigest`, so local and contract semantics disagree too.

The EVM probe confirmed that a new head different from the pre-funded value reverts `InvalidMilestone`. D1's live runner works around the boundary by generating all heads before funding and passing those heads as acceptance specifications. That is lifecycle evidence, not runtime checkpoint integration.

**Repair:** freeze acceptance criteria separately from the actual checkpoint commitment. The signed offer binds the runtime checkpoint; buyer verification checks the agreed deliverable, all required content readback and any required verifier attestation. Store or make recoverable the exact Arkiv locator, serialized-payload digest, artifact commitment, sequence and schema. Add a test that funds first, then encrypts/stages a fresh checkpoint and accepts its previously unknown digest.

### F03 — P1: B cannot reuse A's paid logical operation

Source: [gateway.ts](../server/src/services/gateway/gateway.ts), lines 66–76; [operationLedger.ts](../server/src/services/ledger/operationLedger.ts), lines 84–95.

The request fingerprint includes `worker` and `epoch`. After an authorized handoff, B's retry of exactly the same service/input/amount and operation ID produces `OPERATION_KEY_REUSED`. B needs this path precisely when A died after payment but before checkpoint acceptance. Creating another operation ID risks a second purchase.

**Repair:** distinguish immutable logical purchase identity from the currently authorized caller. Preserve the original producer and add reuse evidence for B after authorization. D1 contains a relevant fix in `8c1f09c`, but it targets a JSON ledger; port the behavior into D2's SQLite transaction model. Regression: A settles, crashes before checkpoint, B reuses the same operation, provider submit count remains one across gateway restart.

### F04 — P1: drain/takeover does not reconcile pending purchases

Source: [gateway.ts](../server/src/services/gateway/gateway.ts), lines 154–161; [jobStore.ts](../server/src/domain/jobs/jobStore.ts), lines 183–203; [app.ts](../server/src/app.ts), lines 136–145.

`drain()` changes a local flag and returns; takeover goes directly to JobStore and clears that flag. With a provider deliberately held in `SUBMITTED`, the probe drained and assigned B while A's request was still running. A separate probe reopened B with an `UNKNOWN` purchase. This contradicts the documented reconciliation barrier. Previously admitted external work may settle after an epoch change, so this must be explicit rather than treated as revoked.

**Repair:** serialize admission/drain under one gateway coordinator, persist the drain generation, reconcile or block on all relevant pending operations, then verify the confirmed new chain assignment before reopening. A failed takeover remains drained. Provide a real cancel-drain/resume path: current `Gateway.resume()` only accepts `PAUSED`, so a plain `DRAINED` job cannot be resumed through it. Test restart while drained and both head-race orders.

### F05 — P1: payment success and durable output availability are conflated

Source: [gateway.ts](../server/src/services/gateway/gateway.ts), lines 27–43 and 99–121; [hederaX402.ts](../server/services/provider/hederaX402.ts).

The provider fixture returns `local://paid-output/...` without storing bytes. The gateway immediately marks the operation `OUTPUT_AVAILABLE`. The real helper returns bytes and an optional payment-response header, but does not implement the gateway's submit/reconcile contract, provider lookup or Arkiv persistence. No provider service with durable successor retrieval is included.

**Repair:** keep settlement durable independently of content availability. Encrypt returned bytes, persist them in Arkiv, verify readback and digest, then mark available. On a crash between settlement and storage, retrieve the already purchased output; never automatically pay again. Bind actual x402 network, asset, payee, maximum debit and fee allowance to the reservation before signing payment. Current caller-supplied `amount` is not verification of the endpoint's actual payment challenge. Require provider idempotency/status/output entitlement before claiming exactly-once reuse.

### F06 — P1: no authenticated, chain-backed live gateway exists here

Source: [app.ts](../server/src/app.ts), lines 11–18 and 64–72; [JobAuthority.sol](../server/contracts/src/JobAuthority.sol); [env.ts](../server/src/config/env.ts).

Worker/buyer addresses are supplied in JSON, without request signatures or actor authorization. Nonproduction fixture routes are deliberately disabled in production, which is a useful safeguard; this is a missing live path, not evidence that a live payment gateway is exposed. The branch's authority wrapper expects `isAuthorized(bytes32,address)`, while the newer D1 implementation reads ENS scoped roles. `CONFIRMATION_BLOCKS` is reported but not applied to authority/head reads on this branch.

**Repair:** bring in D1's ENS adapter and chain reader, then add worker signed requests and buyer-only administrative operations. Bind action, job/task, epoch, policy, payload, nonce, expiry and deployment identity. Pin a confirmation policy and coherent block reads; close admissions on RPC disagreement/reorg. D1's reader uses latest reads without the configured confirmation threshold, so importing it alone is insufficient. Validate chain task/head/terms bindings as well as worker/epoch.

### F07 — P1 integration gap: checkpoint wire format and key access are unfinished

Sources: [protocol/v1.ts](../server/src/protocol/v1.ts), [checkpoint/schema.ts](../server/packages/checkpoint/src/schema.ts), [checkpoint/crypto.ts](../server/packages/checkpoint/src/crypto.ts), [storage/arkiv.ts](../server/packages/storage/src/arkiv.ts).

The protocol uses `schemaVersion: "checkpoint.v1"`; the encrypted manifest uses numeric `1`. There are separate canonical serializers, string UUID job/task IDs locally versus bytes32 in signatures, null versus zero-hash initial heads, and two distinct hashes named `ciphertextDigest`: the inner nonce/ciphertext/tag hash and the hash of the full serialized Arkiv payload. Distinct hashes are legitimate; an undefined mapping between them is not a recovery protocol. The diagnostic confirms they differ.

The contract/event records only a bytes32 head; the cold worker has no implemented resolver from that head to the exact manifest entity. `CHECKPOINT_KEY_SERVICE_URL` is parsed but never used. A and B's key grant and authenticated recovery coordinator do not exist.

**Repair:** publish one versioned boundary specification and golden fixture covering chain IDs, task IDs, schema, sequence, previous head, outer payload digest, inner authentication digest and Arkiv locator. Define which exact bytes the offer commits. Buyer owns the encryption key and issues B fresh scoped access; no worker wallet key transfer. Before signing acknowledgement, verify manifest identity, accepted head, adapter version, artifacts and key access.

### F08 — P2: fixture success is broader than contract success

The local JobStore accepts a cutoff in the past, then allows assignment, spending and milestone acceptance. A focused probe also accepted sequence `999`, an unsupported schema string and `arkiv://missing` without reading content. It has no close/refund transition. The contract has deadlines and closure, but its checks do not validate storage or the full local head structure.

Keep fixture mode explicit. Share validation and contract-conformance cases so a local pass cannot imply an equivalent live pass. Do not turn these unsigned fixture endpoints into production payment controls.

### F09 — P2: task identity and conformance evidence are insufficiently bound

Gateway admission checks job worker/epoch, but not `request.taskId === job.task.taskId`; the diagnostic paid under an unrelated task ID. This is already an incorrect binding in the one-task fixture, and becomes a budget/authority issue if task policies expand. Capability probes also match only server/tool/schema, not worker identity, credential scope or freshness, so a shared successful probe can qualify multiple candidates without proving each candidate's own connection.

Bind task identity now. Keep candidate-specific live probes and signed profile verification on the extension backlog until wired to actual takeover. A nonzero compatibility hash alone does not prove admission occurred.

### F10 — P2: state transitions can corrupt accounting or prevent recovery

`SETTLED → UNKNOWN → SETTLED` is allowed by the SQLite ledger and moves the amount from reservations to spend again. The diagnostic used another operation's reservation to make the second settlement succeed: reserved balance fell from 3 to 1 while that second operation still reserved 3. The scalar conservation equation alone misses this discrepancy. `UNKNOWN → OUTPUT_AVAILABLE` also permits skipping settlement accounting. Gateway reconciliation cannot release a proven non-settlement: `{settled:false}` keeps UNKNOWN blocked indefinitely because not-found, uncertain and authoritatively failed are not distinguished.

Specify legal transitions together with immutable settlement facts; convert money once per logical operation. Check the sum of per-operation unsettled reservations against the budget row. Reconciliation needs explicit settled / definitely-not-settled / unknown outcomes. Also test persistence errors: JobStore mutates memory before a file write succeeds and does not roll back, and job creation and ledger budget creation are separate stores without an atomic recovery protocol.

### F11 — P2: Arkiv storage lifecycle and scale guarantees are still design work

The SDK adapter exists, but its tests replace both actual write and read methods. They do not validate live SDK entity encoding, transaction finality, owner permissions or renewal. `stageManifest()` writes one serialized envelope and has no linked-index fallback for an oversized manifest. `extend()` is a primitive, not a renewal monitor. Chunk references drop expiry information, and no acceptance coordinator checks every referenced entity's retention coverage. Artifact reconstruction loads all chunks into memory with unbounded parallel reads.

For the next proof, use a buyer-controlled storage signer so A's failure does not remove renewal authority, record each entity's owner/expiry, and demonstrate extension after A stops. This is a recommended policy, not an executed ownership change. Keep all payloads in Arkiv as already required. Large manifests, bounded reconstruction and candidate adapters remain explicit backlog items until tested.

## Branch reconciliation is the first dependency

The remote D1 branch contains five commits after the common base that are missing here: `45a53bd`, `4068a10`, `9d09feb`, `8c1f09c`, `e1d7b2c`. Useful additions include ENS scoped-role authority, deployment/lifecycle scripts, public Sepolia evidence, gateway serialization and successor reuse.

A non-mutating `git merge-tree --write-tree` dry run found **8 conflicts**: `README.md`, `package.json`, `requests.md`, `scripts/acceptance-local.mjs`, `server/src/app.ts`, `server/src/services/gateway/gateway.ts`, `server/src/services/ledger/operationLedger.ts`, `test.md`.

Keep D2 checkpoint/storage/runtime/MCP modules and the SQLite ledger. Port D1 behavior into them and reconcile shared scripts/types. Do not select all of D1's ledger during conflict resolution: that implementation persists JSON and would undo D2's SQLite guarantees. No merge, implementation fix, deployment or push was performed in this audit.

D1's checked-in Sepolia evidence records a 3/7 lifecycle `LIVE_PASS` on 5 November at 21:37 UTC, with scoped grants and actual reward claims. It is absent from this runtime tree, and was inspected as recorded evidence, not independently reverified on chain. Its synthetic heads and once-per-worker withdrawals do not cover F01/F02. [D1 evidence at the inspected commit](https://github.com/ashwera/baton/blob/e1d7b2c675dfe4bb395f17a1434487588e86684a/evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json).

## What context.md and the architecture need

| Document area | Required correction / addition |
|---|---|
| `context.md`: implementation status | Record branch and SHA for each proof. Separate the 15 current tests, historical 22-test/100k claims, D1 recorded Sepolia lifecycle and pending integrated recovery. No current 100k harness is present here. |
| `context.md`: canonical checkpoint | Define the single head commitment and locator recovery protocol; separate acceptance specification from runtime ciphertext digest; reconcile schema/ID/empty-head representations. |
| `context.md`: withdrawals | State cumulative accepted minus cumulative withdrawn accounting, including repeated claims during a job. |
| `context.md`: payment portability | Define operation identity independent of worker/epoch, successor entitlement and immutable original producer; require real provider lookup and stored bytes. |
| Both: handoff state machine | Specify durable drain, pending/UNKNOWN barrier, chain confirmation, failed-takeover recovery, restart and reopening authority. |
| Both: spending enforcement | Specify authenticated caller/admin boundaries, verified challenge debit/asset/payee/fees, per-task binding and confirmed chain state. |
| Both: keys and retention | Choose ownership/renewal authority, scoped B key grants, entity inventory and expiry coverage. Existing docs correctly call ownership unresolved; close that decision before live writes. |
| Architecture §9 | Replace proposed ABI with actual supported surface, or mark planned extensions. Contract `verifier` is stored but unused; assignment has no initial worker consent signature. Specify buyer-only verification versus mandatory verifier attestation. |
| Architecture §10 | Fix incorrect statement that SQLite and contract authority are unimplemented. Correct paths: admission is `server/services/admission`; SQLite is `server/src/services/ledger`; gateway is `server/src/services/gateway`; worker CLI is `server/apps/worker`. Several listed `server/src/services/*` directories are placeholders. |
| Architecture §3/§9 | Explicitly identify the current single-task contract. A task DAG, independent task epochs, dependency commitments and multi-task budgets are not implemented. |
| `plan.md` | Remove mirror recovery as a requirement: it conflicts with the later Arkiv-only decision. Replace nonexistent `pnpm smoke:testnet`, handoff/payment-crash/DAG commands with actual runnable scripts and owners. |
| `test.md`, status and requests | Import the D1 scripts/evidence before listing those commands as runnable. Retire the stale missing-ENS-adapter request only after integrating and verifying the correct adapter deployment. Fix the Node minimum mismatch (22.12 in test.md versus 22.13 in package.json). |

## Next four hours: dependency order and proof at each stop

These are focused work blocks for the existing D1/D2 roles, not a claim that external integration can be guaranteed in four hours. Use elapsed time from the next work session. Do not spend the first block on dashboard styling or the broader DAG/matchmaking extensions.

| Elapsed | D1: authority / payments | D2: execution / recovery | Exit evidence |
|---|---|---|---|
| 0–30 min | Reconcile newer D1 code with runtime branch; retain SQLite; share ABI/types | Retain runtime/storage/MCP suites; pin one checkpoint fixture and live dependency checklist | One integrated revision builds; existing 15 tests + acceptance pass; eight conflicts resolved intentionally |
| 30–90 min | Fix repeated claims and acceptance-spec/head coupling; add contract regressions; decide verifier boundary | Implement exact-head locator/import boundary and scoped buyer key access; prove Arkiv write/readback and buyer renewal using configured testnet host | Fund-then-stage-then-accept uses a fresh digest; claim→earn→claim works; B can fetch/decrypt exact content without A's directory |
| 90–150 min | Port successor reuse and drain locking into SQLite; bind worker signatures, task and confirmed chain assignment | Connect actual paid provider through gateway; enforce approved challenge cap; persist/read back paid output in Arkiv | A paid operation can be reused by B without a second submit; UNKNOWN stays blocked; actual charged amount matches reservation |
| 150–210 min | Use reviewed new escrow/ABI if contract changed; coordinate grants, drain, takeover, stale-A rejection and claims | Run independent A/B processes, then separate hosts; kill A after settlement before acceptance; recover output and accepted work | Same logical operation/receipt survives crash; B completes; stale work/spend fails; A/B balances and final artifact verified |
| 210–240 min | Verify refund/deadline, repeated claims and accounting evidence on exact candidate | Save receipts/entity IDs/commit/commands; correct docs; add a minimal operational control view if time remains | Reproducible main flow and fault report; each live/local/pending claim has evidence |

The critical external gates are a working Arkiv writer with chosen owner/renewal policy, a provider that offers paid-result lookup/idempotency, buyer-controlled key grants, and a reachable B host. This audit cannot establish their availability from source. If one is blocked, continue the independent contract/gateway work and mark the corresponding live gate blocked; do not replace it with a fixture and call the main flow complete.

First hour priority: F01 + F02 + branch reconciliation. Next priority: one real, recoverable paid output and the B takeover barrier. The landing page, capability ranking, quantitative adapters, huge-context manifests and task DAG do not resolve those core dependencies.

## Required regression cases before the next integrated claim

1. Fund before producing a checkpoint; accept the fresh ciphertext commitment and recover its exact Arkiv locator.
2. Claim 3, earn 4 more, claim 4; duplicate claim fails; closure preserves remaining earned credits.
3. A pays, dies before checkpoint acceptance; B retrieves the same operation/output with one provider settlement.
4. Drain with a submitted request; restart drained; UNKNOWN blocks reopening; definitively failed payment releases exactly once.
5. Arkiv missing/corrupt content or wrong key prevents acknowledgement and takeover; an unaccepted newer upload is ignored.
6. Both acceptance-versus-takeover orders, stale signatures, replayed worker payment signatures, wrong task and revoked grant.
7. Pause, cutoff, partial refund and service-budget/per-operation reservation conservation; simulate failures between the two persistence stores.
8. Clean B host with fresh credentials and no A filesystem; actual output matches the reference and real withdrawals match the reward schedule.

## Audit attachments

- [Runtime diagnostics](audit/runtime-probes.mjs) and [observations](audit/runtime-probes.json).
- [Local contract diagnostics](audit/contract-probes.mjs) and [observations](audit/contract-probes.json).

The probe scripts intentionally assert the broken behavior at the audited revision; they are audit reproductions, not passing release regressions. Invert their expectations when implementing fixes. The contract probe requires an external Ganache installation, passed through `BATON_AUDIT_GANACHE_MODULE`; no Ganache dependency was added to BATON.

From the repository root, reproduce the runtime observations with:

```sh
npm run build --workspace=server
node docs/audit/runtime-probes.mjs
```

For the local EVM observations, install Ganache outside the repository and provide its module path:

```sh
npm install --prefix /tmp/baton-audit-tools --no-audit --no-fund ganache
BATON_AUDIT_GANACHE_MODULE=/tmp/baton-audit-tools/node_modules/ganache/dist/node/core.js node docs/audit/contract-probes.mjs
```

The existing test sources can be run without the restricted `tsx` CLI socket using:

```sh
node --import tsx --test server/packages/*/src/*.test.ts server/apps/worker/src/*.test.ts server/services/*/*.test.ts server/src/services/ledger/*.test.ts server/src/*.test.ts
```
