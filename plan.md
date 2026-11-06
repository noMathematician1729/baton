# BATON audit remediation plan

Prepared 6 November 2026 (India time).

## 1. Objective and evidence baseline

Complete one reproducible flow: fund a job, let A perform a real paid operation, preserve its output in Arkiv, interrupt A, authorize B on a separate host, recover accepted state and the purchased output without paying twice, reject stale A actions, and withdraw the correct rewards.

This plan is based on the supplied `README.md` and `runtime-recovery-audit.md`. It is a plan, not evidence that any fix has been implemented. Repository source, current branches, deployments and networks were not independently inspected while writing it. All remediation boxes start unchecked.

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| README: integrated D1/D2 code; verification on local `build/authority-payments` at `9976380` | Reported integration and 15 passing local tests, builds, compilation, signing vector and acceptance | Resolution of F01–F11 or a connected live recovery flow |
| Audit: `build/runtime-recovery` at `49394afc0a431d3ce266b68e93fb4425aeadd00e` | Two contract defects and runtime/integration findings at that revision | Current branch contents after subsequent work |
| README status: generated from `49394af`; integration and branch descriptions differ | The baseline needs reconciliation before editing | A reason to repeat a merge blindly |
| D1's recorded Sepolia lifecycle | Historical A/B 3/7 lifecycle evidence with synthetic checkpoint heads | Fresh runtime checkpoint acceptance, repeated claims, paid-output recovery or the repaired escrow |

Keep each proof tied to an exact commit, mode, configuration and deployment. Do not infer closure of an audit finding from an older happy-path test.

## 2. Fixed scope and responsibilities

### Scope decisions

- **Content:** Arkiv holds encrypted checkpoint manifests, artifacts and paid-output payloads. SQLite holds payment metadata. Do not add Pinata, IPFS, a mirror or another content store as a recovery fallback in this remediation.
- **Authority and rewards:** the Sepolia escrow/ENS path determines current assignment, epoch, accepted checkpoint and milestone rewards. Preserve existing earned credits during takeover and closure.
- **Tool purchases:** connect the real Hedera x402 provider through the gateway. Keep tool-purchase spending and milestone reward accounting separate; document their networks, assets and funding sources explicitly.
- **Acceptance:** retain the existing milestone-offer acceptance path for this repair. Make its head and credit transition consistent across local and chain modes. Do not introduce intermediate unpaid checkpoint commits as a parallel redesign.
- **Verification policy:** use buyer-controlled acceptance for the MVP. A stored but unused `verifier` address must not be described as enforced verification. Remove it from a new ABI if practical, or explicitly document it as inactive. Mandatory verifier attestations require a separate, tested policy change.
- **Recovery:** the buyer approves B and grants decryption access. The buyer-host gateway remains the trusted, single SQLite writer. Worker failure is covered; autonomous recovery after loss of the buyer, key service or gateway storage is not claimed.
- **Deferral:** task DAGs, independent task epochs, general matchmaking, extra quantitative adapters and dashboard styling follow the integrated proof. Minimal capability validation for the chosen B remains required.

### Ownership

| Role | Primary responsibility | Required cross-review |
|---|---|---|
| D1 | Escrow, ENS/chain authority, signatures, gateway/SQLite money transitions, deployment and claims | D2 reviews checkpoint boundary and recovery implications |
| D2 | Checkpoint encoding, Arkiv storage, key grants, provider adapter/output retrieval, worker recovery | D1 reviews payment challenge enforcement and authorization |
| Both | Protocol fixture, drain/takeover, fault scenarios, evidence and documentation | Agree on one candidate commit and ABI before live tests |

These are work assignments for the existing team, not a record that either owner has completed them.

## 3. Gates and dependency order

| Gate | Work | Depends on | Exit condition |
|---|---|---|---|
| G0 | Establish the actual integrated baseline and external prerequisites | None | Exact candidate revision, runnable local checks, dependency inventory and explicit blockers |
| G1 | Repair F01/F02; freeze checkpoint/acceptance boundary | G0 | Repeat withdrawals and fund-before-fresh-checkpoint regressions pass |
| G2 | Connect authenticated, confirmed chain authority | G0; final G1 ABI | Worker and buyer requests authenticate; ENS/configuration and coherent confirmed reads pass |
| G3 | Implement real Arkiv recovery and scoped B key access | G1 boundary; G0 network access | B independently fetches, decrypts and validates the exact accepted package; renewal survives A stopping |
| G4 | Repair logical operation identity, SQLite accounting and real paid-output persistence | G0; G1 boundary; G3 for live content | One purchase survives restart/handoff; settlement and output availability are separate facts |
| G5 | Connect durable drain, takeover and reopening | G2–G4 | Pending/unknown work blocks reopening; failed takeover stays drained; confirmed B can resume |
| G6 | Deploy the repaired candidate and execute the separate-host failure scenario | G1–G5 | Real settlement, exact-state recovery, stale-A rejection, correct repeated claims and refund evidence |
| G7 | Close findings and update documentation | G6 evidence, or explicit blocked status | Every claim names its mode and proof; unresolved limits remain visible |

After G0, D1 can repair contracts while D2 prepares the shared checkpoint fixture and Arkiv adapter. D1's ledger work and D2's provider work can proceed together after agreeing on the provider interface. Live gates stay blocked until prerequisites exist; elapsed time does not clear a gate.

## 4. G0 — Establish the baseline before changing code

Owners: both.

- [x] Record the current branch, full commit SHA, uncommitted changes and relationship to `9976380`, `49394af…` and D1's `e1d7b2c…`.
- [x] Verify whether D1 authority/payment changes are already present. If integrated, inspect retained behavior instead of redoing the merge. If missing, integrate deliberately, preserve SQLite and checkpoint/runtime modules, and port D1 JSON-ledger behavior into SQLite.
- [x] Check the eight historically conflicting files: `README.md`, `package.json`, `requests.md`, `scripts/acceptance-local.mjs`, `server/src/app.ts`, gateway, operation ledger and `test.md`. Verify both owner changes survived.
- [x] Inventory actual package scripts, ABIs and deployment evidence. Import missing Sepolia runners/evidence only after resolving their compatibility with the current code; do not list absent commands as runnable.
- [x] Run the README's local verification commands and retain exact output. Distinguish the audit's restricted `tsx` launcher from application failures. If needed, use the documented `node --import tsx --test` route and report the wrapper limitation accurately.
- [ ] Reproduce or convert each audit diagnostic at the current revision. The audit probes assert broken behavior; release regressions must assert the corrected behavior. If probe attachments are absent, reconstruct their cases from the audit.
- [x] Review the `solc`/`tmp` development advisories using the current lockfile. Apply a compatible targeted fix where available; record remaining exposure and rerun compilation/signing checks. Avoid a blind forced dependency upgrade.
- [ ] Confirm: Sepolia RPC, ENS name/resolver/adapter pairing, Arkiv writer credentials/funds, B host, buyer-controlled key service and a real provider with status/output lookup.

**Gate record:** one named candidate revision, local results, which D1 changes are present, and a blocker owner for every unavailable external dependency. No secrets belong in the evidence.

## 5. G1 — Repair contracts and standardize the checkpoint boundary

### F01: repeated withdrawals — D1

Primary file: `server/contracts/src/JobEscrow.sol`.

- [x] Replace the once-ever `claimed` boolean with cumulative accepted/cumulative withdrawn accounting, or an equivalent withdrawable balance with lifetime totals.
- [x] Compute the available amount from actual unpaid credits. Update accounting before the external token transfer; a failed transfer must revert the update atomically.
- [x] Preserve earned credit across assignment, revocation, pause and closure. Recovery of an ENS binding must not be required to withdraw already earned credit.
- [x] Test claim 3 → earn 4 → claim 4; no new credit → duplicate claim fails; claim after takeover; claim after closure; transfer failure leaves credit available.
- [x] Assert per-job accounting: `funded = unallocated + workerCreditsOutstanding + buyerRefundOutstanding + totalWithdrawn`.

### F02 and F07: acceptance criteria versus runtime content — both

Primary files: escrow, `server/src/domain/jobs/jobStore.ts`, `server/src/protocol/`, `server/src/chain/`, checkpoint schema/crypto and Arkiv storage adapter.

- [x] Keep `acceptanceSpecHash` as a commitment to immutable deliverable rules. Remove equality between that value and a runtime checkpoint/artifact digest.
- [x] Bind the worker's signed offer to the actual runtime checkpoint, parent, job/task, sequence, epoch, schema, result/artifact commitment, payee and expiry, as applicable to the action.
- [x] Require the buyer's acceptance coordinator to fetch/decrypt/validate the candidate and required artifacts before local acceptance state advances. The verifier runs before the chain writer; tests use fake Arkiv storage. No live V2 submission has been made.
- [x] Align JobStore and contract checks, including milestone order, deadline, parent head, producer/payee and one award per milestone.
- [x] Preserve the atomic accepted-head/credit transition of the selected MVP protocol. A staged upload earns no credit and does not replace the canonical head.

### Boundary specification to implement

Use one golden fixture shared by Solidity/TypeScript signing, storage and recovery. Adopt the following convention unless the current implementation requires a documented equivalent; agree before coding both sides:

| Boundary item | Required definition |
|---|---|
| Job/task IDs | One canonical bytes32 representation for signed/chain operations; local display IDs map explicitly to it |
| Schema | One checkpoint version with explicit adapters for any legacy numeric/string representations; reject unsupported versions |
| Sequence and initial head | Explicit initial input checkpoint and sequence; zero hash means no committed head, not a second encoding of a valid checkpoint |
| Accepted `newHead` | Hash of the exact stored, versioned serialized encrypted manifest envelope; specify hash algorithm and byte encoding |
| Inner encryption digest | Separately named digest of the defined nonce/ciphertext/tag representation; never confuse it with the outer payload digest |
| Arkiv locator | Exact manifest entity key bound by the signed offer and recoverable from accepted chain state or its confirmed event |
| Artifacts | Manifest enumerates content identities, chunk ordering, digests, lengths and adapter/input versions needed to resume |
| Signature domain | Chain ID, verifying contract, protocol/action type, job/task, epoch, relevant nonce/sequence, parties and deadline |

The stored envelope must not contain its own final digest or later-generated Arkiv entity key as a self-referential field. Stage the envelope, obtain its key, then bind key and digest in the offer. Any searchable index published afterward is discovery data and must match the accepted commitment.

**G1 exit:** fund first, then produce fresh randomly encrypted content, stage it, accept its previously unknown head and recover the exact locator. Changed criteria, wrong parent, mismatched locator or modified bytes fail. F01 regressions pass on a matching EVM configuration. Freeze the new ABI and signing fixture before deployment.

## 6. G2 — Connect live identity and authority (F06, F08, F09)

Owner: D1; D2 supplies worker signing and capability checks.

- [x] Reconcile `ENS_JOB_NAME`, the resolver returned for it, `ENS_RESOLVER_ADDRESS` and the separate `BATON_AUTHORITY_ADAPTER_ADDRESS`. D1's live Sepolia check confirmed the resolver and adapter are distinct and probed the adapter behavior.
- [x] Verify live scoped grants, wrong-job denial and revocation against the pinned ENS deployment and ABI; the prior D1 Sepolia run passed. Namespace/expiry behavior is not claimed beyond those tested cases.
- [x] Add a buyer-signed initial import for a funded chain job; verify its canonical terms, reward pool, cutoff, milestone count and pristine lifecycle at one confirmed block, then journal the local job/budget import idempotently.
- [x] Wire production lifecycle mutations to simulated/mined escrow writes, worker-signed milestone offers and takeover acknowledgements, and confirmed full-snapshot post-reads before local state advances. Worker claims relay the worker's signed raw transaction after validating chain, escrow, calldata, value and recovered sender. Buyer and worker keys are not printed; the server loads only the buyer signer. Fakes cover this path; V2 deployment and live mutation proof remain pending.
- [x] Add an Arkiv candidate verifier that authenticates/decrypts the exact manifest, checks job/task/epoch/sequence/parent and milestone-rule bindings, validates adapter and owner metadata, and reads/verifies referenced artifacts before acceptance. App wiring is conditional on buyer Arkiv signer/key configuration; only fake-backed tests ran.
- [x] Authenticate worker and buyer gateway actions with signatures over action, deployment, job/task, epoch, policy and payload digests, application nonce and expiry. Reject address-only JSON assertions; unit tests cover replay, expiry, actor/deployment/task/action/payload binding.
- [x] Add local buyer-only accepted-checkpoint key-grant administration: buyer EIP-712 signature binds job/task/head/key ID/worker, confirmed Sepolia snapshot validation includes lifecycle and accounting, and the SQLite nonce is consumed before the encrypted key store is written. Replay, non-buyer signer and stale-checkpoint tests pass; no live grant was made.
- [x] Complete HTTP lifecycle route-dispatch regressions: valid signed assignment, worker candidate + buyer acceptance, drain/takeover, pause/resume, worker-signed earned-credit claim relay, paid execution and reconciliation dispatch in-process. Production permits escrow mutations only when the chain writer is configured; it rejects fixture job/payment routes. Authorities, writer and provider are faked in route tests.
- [x] Reject `request.taskId !== job.task.taskId`; bind the request to the funded policy and budget.
- [x] Apply `CONFIRMATION_BLOCKS` to related reads at one coherent block, record its number/hash, and fail closed if that block's hash changes during the read.
- [x] Compare configured Sepolia RPC witnesses at one shared confirmed block; fail closed on head lag, block-hash or contract-state disagreement and surface authority uncertainty as HTTP 503. Backup endpoints are optional in `SEPOLIA_RPC_BACKUP_URLS`; fake clients only were tested.
- [x] Recheck confirmed worker/epoch/drain authority immediately before provider submission. If the recheck fails, mark the operation failed before any provider call; if durable cleanup itself fails, preserve the last state for reconciliation. This narrows but cannot eliminate the race with authority changes after the check; already released external authorizations can settle and must be reconciled.
- [ ] Verify B's actual required tool/runtime access using B-specific credentials, input/output schema and a fresh probe. Candidate ranking and general profile verification remain deferred.
- [x] Document buyer-only initial assignment semantics: the buyer calls `assignTask`, and the escrow requires a grant scoped to that job. The current ABI does not require a worker consent signature; an offline contract regression covers missing grant, worker-originated assignment and reassignment denial.
- [x] Add fixture/contract conformance tests for deadline, sequence/schema validity, assignment, acceptance, pause/resume, takeover, close/refund and earned claims. Content validation stays in the coordinator; a simulated locator is never evidence of live availability.

**G2 exit:** unsigned, replayed, expired, wrong-task, wrong-deployment, revoked and stale-worker requests fail; valid current requests succeed under the documented confirmation policy. Earned claims remain accessible independently of new-work admission.

## 7. G3 — Make Arkiv content independently recoverable (F07, F11)

Owner: D2, with D1 reviewing the accepted locator/head binding.

- [ ] Use a buyer-controlled storage signer for the proof so A stopping does not remove renewal control. Select its actual owner address and key custody policy before live writes.
- [ ] Upload real encrypted input/checkpoint/artifact bytes with the installed SDK. Record entity keys, owner, creation transaction, observed confirmation, expiry, content length and digest for every referenced entity.
- [ ] Read back and verify the manifest and every required chunk/artifact before acceptance. Fail on absent, corrupted, expired or insufficiently retained content.
- [ ] Enforce retention through the acceptance cutoff plus a documented recovery margin, including chunks. Store expiry information; implement a renewal check/monitor and verify extension while A is stopped.
- [ ] Make large-content handling bounded: chunk payloads within verified SDK/network limits; constrain parallel downloads and total memory. Reject oversized manifests explicitly until a tested linked-manifest/index representation exists.
- [x] Implement a buyer-host key service with per-worker bearer-token subjects, exact job/checkpoint/worker grant lookup, encrypted-at-rest keys, and X25519-wrapped responses; provision ignored mode-0600 worker/service env files.
- [ ] Run the service as a buyer-host process independent of Worker A and grant B access to an actual accepted checkpoint; never export worker wallet keys into checkpoint content. D2 confirms the topology; add a temporary HTTPS tunnel and public URLs only if B runs on another machine.
- [ ] Implement a cold recovery entry point that reads the confirmed accepted head/locator, retrieves Arkiv entities, verifies the golden fixture bindings and all artifacts, obtains key access and imports the supported runtime state.
- [ ] B signs its exact-head acknowledgement only after successful import validation. Wrong keys, unsupported adapters, missing data and an unaccepted newer publication cannot produce a valid recovery acknowledgement.

**G3 exit:** B starts with fresh credentials and no A directory, memory or local output files; fetches and decrypts the accepted package through Arkiv; resumes the next unfinished step; and demonstrates renewal after A stops. If the canonical content is lost, stop safely—there is no implicit rewind or content mirror.

## 8. G4 — Preserve paid operations and correct SQLite accounting (F03, F05, F09, F10)

Owners: D1 for ledger/gateway; D2 for real provider and output persistence.

### Stable operation identity and legal transitions

- [x] Define a logical operation ID independently of worker/epoch. Its immutable fingerprint binds job/task, provider/service, input digest, requested operation, network/asset/payee and approved debit policy. Worker/epoch are authorization evidence for each attempt, not a reason to purchase again.
- [x] Preserve original producer, original payment/receipt and successor-reuse evidence. Reject the same operation ID with different immutable purchase parameters.
- [x] Port D1's relevant successor-reuse behavior into SQLite transactions; do not replace SQLite with the JSON ledger.
- [x] Separate immutable settlement facts from output state. Settlement happens at most once; a later transport error must not erase known settlement or move a settled purchase back into unsettled accounting.
- [x] Model reconciliation outcomes explicitly as settled, definitely not settled, or unknown. UNKNOWN retains its reservation; only authoritative non-settlement releases it, once.
- [x] Block `UNKNOWN → OUTPUT_AVAILABLE` from bypassing settlement accounting. Repeated settlement/release/reconcile calls are idempotent.
- [x] Check aggregate reservation against the sum of per-operation unsettled reservations, and aggregate spend against immutable per-operation settlements. A scalar conservation equation alone is insufficient.
- [x] Handle persistence errors: do not leave JobStore memory mutated after a failed disk write. Coordinate job creation and ledger-budget creation through an explicit idempotent recovery journal. Test crashes between stores.
- [x] Preserve SETTLED evidence when recording OUTPUT_AVAILABLE fails; reconcile after restart and recover the output without resubmitting.

### Actual x402 adapter and recoverable output

- [ ] Specify and implement the provider contract: submit a stable operation, query authoritative settlement status, and retrieve the purchased output with buyer/successor entitlement. The unused fetch helper alone does not meet this contract.
- [x] Add a pure x402 v2 `PaymentPolicy` filter and local fixtures for the Hedera network, exact scheme, approved asset/payee, positive atomic-unit amount and operation cap, timeout maximum, and trusted `extra.feePayer` identity. Reject other protocol versions and leave no acceptable candidate when all offers fail.
- [ ] Wire the challenge policy into the provider/client path, then verify real challenge and settlement behavior before enabling a paid request. The Hedera challenge identifies `feePayer` but provides no numeric facilitator fee; validate that trusted identity, and describe the amount cap as a transfer cap, not a fee cap. Reconcile actual debit and unused reservation exactly once.
- [ ] Keep durable SETTLED evidence even when output storage fails. Encrypt actual returned bytes, upload them to Arkiv, verify readback and digest, then mark OUTPUT_AVAILABLE with exact locators.
- [ ] If A/gateway crashes after payment and before storage, recover through the provider's operation lookup/output entitlement, then persist to Arkiv. Do not submit another payment automatically.
- [ ] B must find reusable operations from the buyer gateway's durable ledger even when they were not yet included in the last accepted checkpoint. Preserve authentication and original producer attribution.
- [ ] Stop the live paid-output gate if the provider cannot support stable operation reuse/status/output retrieval. A local no-duplicate test proves only the local adapter behavior; it does not establish exactly-once behavior at a real provider.

**G4 exit:** A settles one operation and crashes before checkpoint acceptance. After gateway restart and authorized handoff, B retrieves that same result with one provider submission/settlement. Receipts, actual debit, ledger totals and Arkiv output bytes agree. Uncertain purchases remain blocked without double spending.

## 9. G5 — Make drain and takeover durable (F04, F06, F10)

Owners: both. Implement one gateway coordinator; use database transactions/generation checks so admission cannot race the drain barrier.

| State | Required behavior |
|---|---|
| RUNNING | Admit authenticated current-worker operations within policy |
| DRAINING | Atomically persist drain generation; deny new submissions; inventory/reconcile existing operations |
| DRAINED | No unresolved potentially paying operations; settled purchases and missing outputs remain explicitly journaled for recovery |
| TAKEOVER_PENDING | Buyer submits B acknowledgement against exact expected head/epoch; admissions stay closed |
| RUNNING under B | Reopen only after confirmed assignment and B's required recovery/tool/key checks |
| Failure or uncertainty | Stay drained/blocked; reconcile chain and operations before any reopen |

- [ ] Hold the barrier for SUBMITTED and UNKNOWN operations until definitive resolution. Keep settled-but-not-yet-persisted output visible and recover it without a new purchase.
- [ ] Persist drain/reopen state and generation across gateway restarts. Remove the direct JobStore path that clears drain independently of the coordinator.
- [ ] Verify B's live grant, exact-head acknowledgement and expected epoch. If A's acceptance wins first, refetch/revalidate/re-sign; if takeover wins first, stale A progress fails.
- [ ] Keep an unsuccessful/reverted/timed-out takeover drained. A timed-out RPC response requires chain reconciliation, not an assumption of failure.
- [ ] Add an authenticated cancel-drain/resume path that rechecks confirmed authority and pending-operation state. Do not reset a DRAINED job through a PAUSED-only shortcut.
- [ ] After reopening, reject stale A checkpoint and spend requests. Reconcile A's previously admitted external work rather than pretending an epoch change cancelled it.

**G5 exit:** submitted/unknown operations block reopening, restart preserves drain, failed takeover stays drained, both head-race orders behave correctly, and only confirmed B can issue new protected work.

## 10. G6 — Deploy and prove the complete failure flow

Owners: both. Use a reviewed new escrow deployment after F01/F02 and signing/ABI changes. Historical deployment evidence remains historical. Match the Solidity compiler, EVM target and local execution engine used for release verification; the audit's Shanghai/Cancun probe combination was limited evidence.

### Main scenario

1. Record candidate SHA, ABI hash, chain IDs, contract/adapter/token addresses, configuration fingerprint and confirmation policy. Establish buyer, A and B as separate keys; A/B run on separate hosts.
2. Verify live ENS authority and publish/read back the buyer-owned initial Arkiv package. Fund before generating the later checkpoint digest.
3. A completes milestone 1. The coordinator validates real stored artifacts; the buyer accepts the fresh checkpoint; A claims its earned credit.
4. A initiates a real paid tool operation for the next step. Capture settlement/operation evidence, then stop A before checkpoint acceptance.
5. Persistently drain. Reconcile pending operations and locate the settled purchase/output. Exercise gateway restart with its SQLite data retained.
6. Start B clean. B retrieves the confirmed accepted checkpoint from Arkiv, gets scoped key access, validates/imports it and prepares exact-head acknowledgement. The buyer approves takeover.
7. Wait for the confirmation policy and reopen under B. B retrieves A's existing paid result through the authorized reuse path without paying again, finishes the workflow and stores its outputs in Arkiv.
8. Attempt A's old checkpoint/spend requests and capture rejection. Verify the actual execution path as well as a negative simulation where appropriate; label each accurately.
9. Accept B's remaining milestones. Exercise claim → additional award → claim for a worker. If the three-milestone 3/7 flow cannot cover this, run a separate same-deployment repeated-claim job.
10. Verify final artifact against the deterministic reference. Reconcile token movements, worker credits, tool spending, reservations and provider receipt/output identity. Run a separate pause/deadline/partial-refund case and preserve earned claims.

### Required release regression matrix

| Case | Finding(s) | Required outcome |
|---|---|---|
| Claim 3, earn 4, claim 4; duplicate claim | F01 | Both legitimate withdrawals succeed; duplicate pays nothing |
| Claim after handoff/closure; failed transfer | F01 | Credit remains correct and claimable |
| Fund, then generate/encrypt/stage fresh head | F02, F07 | Previously unknown digest accepted with exact locator |
| Wrong criteria, parent, schema, sequence or bytes | F02, F07, F08 | Correct layer rejects; canonical head unchanged |
| A settles; crashes before acceptance; B retries same operation | F03, F05 | One provider purchase; same result; original attribution preserved |
| Same ID with changed input/service/asset/payee | F03, F05 | Rejected before a new debit |
| Drain during SUBMITTED; restart while drained | F04 | No new admission or premature reopening |
| UNKNOWN; later settled versus definitively failed | F04, F10 | Retain, settle or release once according to authoritative outcome |
| `SETTLED → UNKNOWN → SETTLED` attempt | F10 | No repeated accounting conversion or other operation's reservation consumed |
| Storage failure after settlement; payment response lost | F05, F10 | Settlement preserved; lookup/retrieval without automatic repayment |
| Unsigned, replayed, expired or wrong-task request | F06, F09 | Rejected before paid side effects |
| Revoked grant, stale epoch, RPC disagreement/reorg | F06 | New work fails closed; confirmed state reconciled |
| Missing/corrupt/expired chunk, wrong key, unsupported adapter | F07, F11 | No acknowledgement/acceptance of unusable package |
| Newer unaccepted upload | F07, F11 | Ignored for canonical recovery |
| A stops before renewal | F11 | Buyer authority can extend every required entity |
| Oversized manifest and constrained-memory reconstruction | F11 | Explicit rejection or tested bounded handling |
| Both acceptance/takeover transaction orders | F02, F04, F06 | One valid order; stale head/epoch transition rejected |
| Disk-write failure and crash between stores | F10 | No orphan spendable budget or memory/disk divergence |
| Past cutoff, pause, partial refund, completion | F08, F10 | Local/chain semantics agree; earned credits preserved |
| Fresh B host and B-specific live tool probe | F07, F09 | Recovery and tool use require no A filesystem/credentials |

Mocked unit and fault tests are appropriate for deterministic regressions. Tests marked live in the final evidence must use the actual network/provider/storage path; an all-mock run does not clear G6.

## 11. G7 — Evidence, documentation and finding closure

- [ ] Update `context.md`: current revision, exact tested modes, checkpoint commitment/locator, cumulative claims, stable purchase identity, drain barrier, keys and Arkiv retention.
- [ ] Update `BATON_Architecture.md`: actual ABI and verifier policy; current single-task scope; implemented SQLite/authority status and correct module paths; trust in buyer gateway/key service/provider.
- [ ] Update `README.md`, `test.md`, `docs/gates.md`, `status/` and `requests.md`: remove stale missing-module assertions, list actual commands, keep Node minimum consistent at the verified supported version, and distinguish local, live, historical and blocked proofs.
- [ ] Replace the repository's build-plan content with this plan only after reconciling any existing owner commitments. This deliverable does not overwrite a repository checkout or claim fixes are applied.
- [ ] Record command, mode, SHA, timestamp/timezone, pass/fail/blocked result, host separation, chain block/hash/confirmation, tx/receipt IDs, Arkiv entity inventory/expiry and artifact digests. Exclude secrets and decryption keys.
- [ ] Give each finding a closure link to its fix commit, regression and integration evidence. Use `OPEN`, `FIXED_LOCAL`, `VERIFIED_LIVE`, `BLOCKED` or `DEFERRED_WITH_LIMIT` rather than a blanket “done.” F11 scale work may be deferred only with explicit enforced size/concurrency limits and a working live retention proof.

| Finding | Owning gate | Closure evidence |
|---|---|---|
| F01 | G1, G6 | Repeated-claim regressions and new-deployment claims |
| F02 | G1, G6 | Fund-first fresh checkpoint accepted/recovered |
| F03 | G4, G6 | Successor reuses real purchase with one provider settlement |
| F04 | G5, G6 | Durable drain, pending/unknown barrier, restart and both races |
| F05 | G3, G4, G6 | Actual challenge/debit verified; purchased bytes retrieved and read back from Arkiv |
| F06 | G2, G5, G6 | Authenticated actors, live ENS, coherent confirmed chain state |
| F07 | G1, G3, G6 | Golden boundary fixture, exact locator, scoped keys and clean-host import |
| F08 | G2, G6 | Local/contract conformance and real lifecycle/refund evidence |
| F09 | G2, G4, G6 | Task binding and chosen B's credential-specific probe |
| F10 | G4, G5, G6 | Legal transitions, per-operation accounting and persistence fault tests |
| F11 | G3, G6 | Live SDK encoding/readback, owner/expiry inventory, renewal and enforced scale limits |

## 12. First work session and stop conditions

Prioritize by evidence rather than a promised four-hour deadline:

1. **Baseline and contract block:** verify integration; fix F01/F02 and agree the shared fixture.
2. **Recovery block:** D2 proves real Arkiv bytes and scoped B import while D1 finishes authenticated authority and SQLite operation/accounting fixes.
3. **Payment/handoff block:** connect the actual provider, persist paid output, enforce durable drain and successor reuse.
4. **Release block:** deploy the repaired candidate, run the separate-host scenario and update claims from its evidence.

Stop the affected live gate when ENS binding is unresolved, provider settlement/output lookup is unavailable, Arkiv ownership/readback/retention fails, B lacks key/tool access, or B's independent host is unavailable. Continue independent local fixes and report the blocker. Do not replace a failed live dependency with a fixture and call integrated recovery complete.

**Completion:** all P0/P1 findings satisfy their release regressions and relevant live gates; remaining P2 limits are fixed or explicitly bounded and documented; the complete crash/recovery/payment scenario is reproducible from the exact candidate revision.

## 13. Current G0–G4 implementation progress — 6 November 2026

The current D1 remediation checkpoint on `build/audit-g0-g4` builds on `52a1022`. The supplied `runtime-recovery-audit.md` is present; the audit's original probe scripts/data are not in the checkout, so findings are being reconstructed as regression tests. The purported `9976380` revision is absent from this repository; D1's `e1d7b2c` is an ancestor, and the inspected D2 audit revision remains historical context.

| Gate | Implemented and locally evidenced | Still open |
|---|---|---|
| G0 | Actual branch/base and merged D1/D2 files identified; package scripts, ABI and live evidence inventoried; root `.env` presence checked without printing values; earlier API restart check passed 1/1 on the user's Mac before the journal change | Pinned dependency parity/security fix; rerun latest API integration on a machine permitting loopback listeners; complete external prerequisite confirmation |
| G1 | Cumulative withdrawals, accounting view, acceptance-spec separation, signed checkpoint fields, local JobStore deadline/parent/sequence validation, twelve Foundry regressions under pinned solc 0.8.28 | Shared fresh-envelope/locator golden test (D2 fixture boundary); deploy/review V2 and prove it through the actual chain and Arkiv path |
| G2 | Action-scoped EIP-712 authorization, durable nonce replay prevention, buyer-signed pristine chain-job import, local buyer-signed accepted-checkpoint key grants, signed route matrix, buyer-only initial assignment, task binding, confirmed multi-RPC reads, provider-boundary authority recheck, fake-backed candidate verifier, production escrow writer with worker offer/ack signatures, signed worker claim relay and confirmed post-write snapshot checks | Deploy/review V2 and prove mutations live; B-specific capability probe and live Arkiv/RPC checks; no accepted-head grant has been made |
| G3 | Exact-head recovery helper, buyer-scoped key-grant client and buyer-host service, per-worker token isolation, encrypted key storage/transport, digest/identity/parent/adapter checks, storage owner/expiry validation, 32 MiB per-artifact / 64 MiB package caps and four-way chunk reads; local B/A smoke passes | Grant for a real accepted checkpoint, buyer-owned SDK write/read, confirmed chain-head lookup, renewal monitoring, and clean-host B recovery; tunnel only if D2 confirms cross-host workers |
| G4 | Provider/network/payee/policy-bound stable fingerprint and successor reuse retained in SQLite; settlement/output facts separated; settled/not-settled/unknown outcomes; per-operation accounting assertions; JobStore copy-on-write and crash-recoverable job/budget provisioning journal; pure x402 v2 challenge filter locally tested against approved fields | Wire the filter into provider/client requests; real settlement/debit/status/output lookup; persist and read paid bytes in Arkiv; live A-to-B crash run |

Earlier candidate evidence (before the compiler-parity follow-up): `npm run typecheck`, `npm run build`, and the documented direct `node --import tsx --test ...` offline suite passed; 58/58 tests cover production route gating with/without a writer, simulated Sepolia escrow writes, raw worker-signed claim validation, local state remaining unchanged on a mismatched post-write read, provider-boundary authority revocation, key-grant/replay checks, fake-backed candidate verification, RPC agreement/disagreement, chain import and accounting/restart cases. The current run also passed `npm run test:local`, `npm run test:signing`, `npm run contracts:compile`, `npm run key-service:smoke`, and Foundry 12/12 with pinned solc 0.8.28 through an isolated offline wrapper. Route tests do not open a TCP listener; writer, candidate and RPC tests do not contact external networks. An earlier API restart test passed 1/1 on the user's Mac before the new job-provisioning journal path. The latest API integration rerun is unverified: this execution sandbox rejects loopback listeners with `EPERM`; rerun it locally with `node --import tsx --test server/src/app.integration.test.ts`. No live transaction, Arkiv write, or x402 payment was made.

D1 continuation evidence: the current direct offline suite passes 73/73, `npm run test:local` and `npm run test:signing` pass, and Foundry recompiles/tests 12/12 when forced through pinned solc 0.8.28. A clean `npm ci --ignore-scripts` restored exact 0.8.28 compiler parity, and `npm run contracts:compile` passes. The locked `tmp@0.0.33` advisories remain open pending compatibility verification for a patched version. The focused D1 regressions are in the contract suite, local acceptance script, and SQLite ledger tests; the audit attachment probes were not present in the checkout.

The root `.env` is ignored and mode `0600`. A value-presence-only scan found `ARKIV_ACCESS_KEY` and a validly formatted `CHECKPOINT_ENCRYPTION_KEY`; `ARKIV_RPC_URL` and `ARKIV_SIGNER_PRIVATE_KEY` remain missing. `.env.key-service` and separate `.env.worker-a` / `.env.worker-b` files were generated locally with mode `0600`; their current URLs are loopback. D2 will confirm whether a tunnel is needed. The service process is not left running by this execution shell. No accepted-chain checkpoint grant has been added. No secret values are included in this plan. The historical live label remains **Sepolia lifecycle: LIVE_PASS; full integration: pending.** The revised escrow ABI has not been deployed.

## 14. Remaining G0–G4 work that does not need `.env` changes

These are available local/code tasks. Live-network claims remain out of scope until their separate inputs and services are ready.

| Gate | Remaining work without editing `.env` |
|---|---|
| G0 | D1 assertions for F01/F02/F03/F06/F08/F09/F10 are in contract, local acceptance, route/authority, and SQLite tests; original audit probes are absent. Compiler manifests, lock and current install now match exact solc 0.8.28. Remaining: assess a patched compatible `tmp` and rerun the latest API journal integration on the user's Mac. |
| G1 | D1 contract lifecycle, deadline, pause, withdrawal and refund regressions pass 12/12 under pinned solc 0.8.28. The shared fresh-envelope/locator golden fixture is D2's boundary task; V2 deployment and real chain/Arkiv acceptance remain pending. |
| G2 | Production escrow writes, worker offer/ack signatures, worker-signed claim relay, pre-write admission and confirmed post-write checks are wired and locally tested. Remaining live work: deploy/review V2, run funded mutation verification, make a real accepted-head key grant, and complete B's capability probe and RPC/content checks. |
| G3 | D2-owned: buyer-owned SDK write/read and retention, exact live accepted-head grant, clean-host B recovery, renewal monitoring and any cross-host tunnel. D1's accepted locator/head verifier is wired before acceptance; review the shared boundary without duplicating D2's recovery work. |
| G4 | Provider/network/payee/approved-policy identity is part of the stable fingerprint; original producer and successor reuse remain auditable. The SQLite provisioning journal repairs either JSON-job/SQLite-budget crash window, and a local regression preserves settlement through output-state write failure and restart without a second submission. A separate pure x402 v2 policy test covers challenge constraints. Remaining: connect that filter to provider requests, verify actual settlement/debit/status/output, and persist/read paid bytes in Arkiv with D2's provider path. |

The remaining live requirements are tracked separately: configured Arkiv RPC/signer, a running buyer-host key service with a live checkpoint grant, buyer-owned entity retention, B's host topology, confirmed chain state, and a real provider that exposes settlement and output lookup. Add a temporary tunnel only for cross-host workers. The HTTP-listener and compiler-download blockers are execution-environment issues, not `.env` fields.
