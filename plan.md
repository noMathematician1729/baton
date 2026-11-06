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
- **Recovery:** B is preapproved through its scoped ENS grant and receives buyer-authorized decryption access. A deterministic buyer-side runner executes the configured timeout policy; it is trusted buyer infrastructure, not trustless succession. The buyer-host gateway remains the trusted, single SQLite writer. Worker failure is covered; autonomous recovery after loss of the buyer, key service or gateway storage is not claimed.
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
- [x] Require the buyer's acceptance coordinator to fetch/decrypt/validate the candidate and required artifacts before local acceptance state advances. The verifier is wired before the gateway accepts; tests use fake Arkiv storage, and production chain submission remains disabled until the chain writer is connected.
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

- [x] Add one test-only encrypted boundary fixture consumed by Foundry acceptance and TypeScript EIP-712 signing, storage and recovery. The fixture uses a fixed test key; runtime encryption continues to use fresh random nonces.

**G1 exit:** fund first, then produce fresh randomly encrypted content, stage it, accept its previously unknown head and recover the exact locator. Changed criteria, wrong parent, mismatched locator or modified bytes fail. F01 regressions pass on a matching EVM configuration. Freeze the new ABI and signing fixture before deployment.

## 6. G2 — Connect live identity and authority (F06, F08, F09)

Owner: D1; D2 supplies worker signing and capability checks.

- [x] Reconcile `ENS_JOB_NAME`, the resolver returned for it, `ENS_RESOLVER_ADDRESS` and the separate `BATON_AUTHORITY_ADAPTER_ADDRESS`. D1's live Sepolia check confirmed the resolver and adapter are distinct and probed the adapter behavior.
- [x] Verify live scoped grants, wrong-job denial and revocation against the pinned ENS deployment and ABI; the prior D1 Sepolia run passed. Namespace/expiry behavior is not claimed beyond those tested cases.
- [x] Add a buyer-signed initial import for a funded chain job; verify its canonical terms, reward pool, cutoff, milestone count and pristine lifecycle at one confirmed block, then journal the local job/budget import idempotently.
- [x] Wire production assignment, milestone acceptance, pause and resume through the buyer escrow writer; worker checkpoint offers use the contract EIP-712 signature, and each write is followed by a confirmed chain-state check before local state advances. Exact confirmed assignment/checkpoint retries reconcile after a lost API response. Rewards are marked claimed only after a confirmed worker-signed escrow `claim(jobId)` transaction and matching per-worker chain accounting. Local tests use fake RPC/transactions; this has not been exercised against the configured V1 deployment, and V2 live verification remains deferred.
- [x] Add an Arkiv candidate verifier that authenticates/decrypts the exact manifest, checks job/task/epoch/sequence/parent and milestone-rule bindings, validates adapter and owner metadata, and reads/verifies referenced artifacts before acceptance. App wiring is conditional on buyer Arkiv signer/key configuration; only fake-backed tests ran.
- [x] Authenticate worker and buyer gateway actions with signatures over action, deployment, job/task, epoch, policy and payload digests, application nonce and expiry. Reject address-only JSON assertions; unit tests cover replay, expiry, actor/deployment/task/action/payload binding.
- [x] Add local buyer-only accepted-checkpoint key-grant administration: buyer EIP-712 signature binds job/task/head/key ID/worker, confirmed Sepolia snapshot validation includes lifecycle and accounting, and the SQLite nonce is consumed before the encrypted key store is written. Replay, non-buyer signer and stale-checkpoint tests pass; no live grant was made.
- [x] Complete HTTP route-dispatch regressions for signed assignment, worker candidate + buyer acceptance, buyer drain, pause/resume, earned-credit claim, paid execution and reconciliation. Chain-mode `/takeover` is deliberately rejected in favor of the policy runner. Production rejects fixture mutation routes when the policy runner is disabled. Authority, verifier and provider are fake or local in these tests.
- [x] Reject `request.taskId !== job.task.taskId`; bind the request to the funded policy and budget.
- [x] Apply `CONFIRMATION_BLOCKS` to related reads at one coherent block, record its number/hash, and fail closed if that block's hash changes during the read.
- [x] Compare configured Sepolia RPC witnesses at one shared confirmed block; fail closed on head lag, block-hash or contract-state disagreement and surface authority uncertainty as HTTP 503. Backup endpoints are optional in `SEPOLIA_RPC_BACKUP_URLS`; fake clients only were tested.
- [x] Recheck confirmed worker/epoch/drain authority immediately before provider submission. If the recheck fails, mark the operation failed before any provider call; if durable cleanup itself fails, preserve the last state for reconciliation. This narrows but cannot eliminate the race with authority changes after the check; already released external authorizations can settle and must be reconciled.
- [x] Add Worker B's credential-isolated MCP schema discovery (`worker:tools:b`) and read-only probe (`worker:probe:b`). The probe binds server/tool/schema version and input/output schema digests, checks the result digest, and refuses to call tools that do not advertise read-only behavior; the synthetic MCP path and mismatch/safety cases pass locally.
- [ ] Verify B's actual required tool/runtime access using B-specific credentials, input/output schema and a fresh probe. Candidate ranking and general profile verification remain deferred.
- [x] Document buyer-only initial assignment semantics: the buyer calls `assignTask`, and the escrow requires a grant scoped to that job. The current ABI does not require a worker consent signature; an offline contract regression covers missing grant, worker-originated assignment and reassignment denial.
- [x] Add fixture/contract conformance tests for deadline, sequence/schema validity, assignment, acceptance, pause/resume, takeover, close/refund and earned claims. Content validation stays in the coordinator; a simulated locator is never evidence of live availability.

**G2 exit:** unsigned, replayed, expired, wrong-task, wrong-deployment, revoked and stale-worker requests fail; valid current requests succeed under the documented confirmation policy. Earned claims remain accessible independently of new-work admission.

## 7. G3 — Make Arkiv content independently recoverable (F07, F11)

Owner: D2, with D1 reviewing the accepted locator/head binding.

- [ ] Use a buyer-controlled storage signer for the proof so A stopping does not remove renewal control. Select its actual owner address and key custody policy before live writes.
- [ ] Upload real encrypted input/checkpoint/artifact bytes with the installed SDK. Record entity keys, owner, creation transaction, observed confirmation, expiry, content length and digest for every referenced entity.
- [ ] Read back and verify the manifest and every required chunk/artifact before acceptance. Fail on absent, corrupted, expired or insufficiently retained content.
- [x] Add buyer-signer-owned retention extension and a daily monitor that checks the confirmed accepted head, manifest and chunks; renew entities within a 45-day safety window and retain them for 30 days beyond the task cutoff. Read back extended metadata and allow the live expiry to exceed the signed manifest's original expiry floor. Local tests use fake Arkiv state.
- [ ] Verify the renewal transaction and readback on a real accepted checkpoint while Worker A is stopped; keep the buyer-host monitor alive through the job cutoff plus recovery margin.
- [x] Enforce local large-content bounds: 96 KiB encrypted chunks, 32 MiB per artifact, 64 KiB plaintext manifests, 96 KiB serialized envelopes and at most four parallel chunk reads. Tests reject oversized artifacts/manifests before writes and verify read concurrency. Confirm the chosen bounds against the live SDK/network during G6 before treating the live scale limit as verified.
- [x] Implement a buyer-host key service with per-worker bearer-token subjects, exact job/checkpoint/worker grant lookup, encrypted-at-rest keys, and X25519-wrapped responses; provision ignored mode-0600 worker/service env files.
- [ ] Run the service as a buyer-host process independent of Worker A and grant B access to an actual accepted checkpoint; never export worker wallet keys into checkpoint content. D2 confirms the topology; add a temporary HTTPS tunnel and public URLs only if B runs on another machine.
- [x] Implement a cold recovery entry point that reads the confirmed accepted head/locator, retrieves Arkiv entities, verifies the golden fixture bindings and all artifacts, obtains key access and imports the supported runtime state. `recover-accepted` is available through `npm run worker:recover:b`; B uses a read-only Arkiv client.
- [x] B signs its exact-head acknowledgement only after successful import validation. Local regressions reject mismatched heads and corrupt runtime state before any acknowledgement request.

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

- [x] Define the provider contract for stable submit, settlement lookup, and output retrieval, and implement the gateway adapter around that contract. A concrete provider client must supply authoritative lookup/output behavior before live payment is enabled.
- [x] Verify x402 v2 challenge network, asset, payee, exact scheme, fee-payer identity and maximum amount before signing. Reserve the maximum; record actual settlement and release the unused reservation once. Reject mismatches and excess charges.
- [x] Keep durable SETTLED evidence when output storage fails. Encrypt output through the Arkiv content store, persist its exact artifact pointer in the ledger, and provide digest-checked readback. Local tests use a fake Arkiv client.
- [x] On recovery, use the provider's operation lookup/output contract to retrieve an existing settlement and persist it to Arkiv without another submit. The configurable HTTP client enforces the local contract; actual service compatibility remains unverified.
- [x] Let authenticated B discover paginated, output-ready operations in the buyer gateway ledger, including operations created after the last accepted checkpoint. Preserve immutable intent, original producer attribution, and signed reuse authorization; route, ledger and worker-client tests cover the path.
- [x] Fail closed in production unless the x402 submit URL, authoritative status URL, output URL, payer and buyer-owned Arkiv output store are configured; unknown status holds the reservation. A separately tested local-provider guard prevents fixture spending. Keep the live gate open until the actual provider confirms idempotent submit and authoritative lookup/output compatibility.
- [ ] Verify the configured real provider honors stable operation reuse/status/output retrieval before declaring the paid-output gate live. Local no-duplicate tests prove only the adapter behavior, not the provider's exactly-once contract.

**G4 exit:** A settles one operation and crashes before checkpoint acceptance. After gateway restart and authorized handoff, B retrieves that same result with one provider submission/settlement. Receipts, actual debit, ledger totals and Arkiv output bytes agree. Uncertain purchases remain blocked without double spending.

## 9. G5 — Make drain and takeover durable (F04, F06, F10)

Owners: both. The current branch now has the initial opt-in buyer policy runner, authenticated heartbeat and B acknowledgement paths, durable admission barrier, reconciliation loop and Sepolia buyer transaction writer. Keep the remaining G5 work focused on automated regression/failure coverage and chain-head races.

| State | Required behavior |
|---|---|
| RUNNING | Admit authenticated current-worker operations within policy and record server-observed, epoch-bound heartbeats |
| DRAINING | Atomically persist drain generation; deny new submissions; wait for already active provider submits; inventory/reconcile existing operations |
| DRAINED | No unresolved potentially paying operations; settled purchases and missing outputs remain explicitly journaled for recovery |
| TAKEOVER_PENDING | Buyer runner submits B's signed acknowledgement against the exact accepted head/epoch; admissions stay closed |
| RUNNING under B | Reopen only after the configured Sepolia confirmations and a fresh confirmed assignment/epoch read |
| Failure or uncertainty | Stay drained/blocked; reconcile chain and operations before any reopen |

- [x] Hold the local admission barrier for SUBMITTED and UNKNOWN operations; wait for active submits to leave the job lock before reconciling.
- [x] Persist drain/reopen state and generation in SQLite; workers cannot reopen a DRAINED task through the API.
- [x] Add EIP-712 heartbeat admission, durable last-seen state, a B exact-head acknowledgement endpoint and a buyer-only Sepolia writer with configured confirmations and post-write confirmed reads.
- [ ] Verify B's live grant, exact-head acknowledgement and expected epoch against the deployed V2 escrow. If A's acceptance wins first, fail closed on the stale head; require B to recover and sign the updated accepted head.
- [x] Keep a failed takeover drained across restart; add local regression coverage for retry and both acceptance/takeover orders. On-chain revert, timeout and reorg behavior still need live V2 verification.
- [x] Add an authenticated cancel-drain path that reconciles pending work, rechecks confirmed assignment/head/grant state and uses a buyer-only contract call before reopening. A DRAINED task cannot be reopened through the PAUSED-only resume route.
- [x] After reopening, reject stale A checkpoint and spend requests. Drain reconciliation retains A's already-admitted provider work until its outcome is definitive.

The runner is disabled by default. Set `TAKEOVER_POLICY_ENABLED=true` only with Sepolia authority configured, buyer signer matching the job buyer, and the configured A/B addresses. Worker A starts `startWorkerHeartbeatLoop` with an interval shorter than the buyer timeout; no heartbeat means no timeout trigger. Worker B uses `submitRecoveredCheckpointAcknowledgement` only after `recoverAcceptedPackage` succeeds. The 60-second timeout is a configurable demo default, not proof that A has died.

**G5 exit:** submitted/unknown operations block reopening, restart preserves drain, failed takeover stays drained, both head-race orders fail closed or reject stale A, and only confirmed B can issue new protected work. Focused local regressions now cover these controls. The gate remains open for live V2 confirmation, B's live grant/acknowledgement and re-acknowledgement after a newer accepted head.

## 10. G6 — Deploy and prove the complete failure flow

Owners: both. Use a reviewed new escrow deployment after F01/F02 and signing/ABI changes. Historical deployment evidence remains historical. Match the Solidity compiler, EVM target and local execution engine used for release verification; the audit's Shanghai/Cancun probe combination was limited evidence.

### Main scenario

1. Record candidate SHA, ABI hash, chain IDs, contract/adapter/token addresses, configuration fingerprint and confirmation policy. Establish buyer, A and B as separate keys; A/B run on separate hosts.
2. Verify live ENS authority and publish/read back the buyer-owned initial Arkiv package. Fund before generating the later checkpoint digest.
3. A completes milestone 1. The coordinator validates real stored artifacts; the buyer accepts the fresh checkpoint; A claims its earned credit.
4. A initiates a real paid tool operation for the next step. Capture settlement/operation evidence, then stop A before checkpoint acceptance.
5. Persistently drain. Reconcile pending operations and locate the settled purchase/output. Exercise gateway restart with its SQLite data retained.
6. Start B clean. B retrieves the confirmed accepted checkpoint from Arkiv, gets scoped key access, validates/imports it and signs its exact-head acknowledgement. After the missed-heartbeat interval and payment reconciliation, the buyer-side runner submits the preauthorized drain/takeover calls.
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

- [x] Consolidate the durable design context in `BATON_Architecture.md`; keep current implementation evidence in `README.md` and `docs/gates.md`.
- [x] Update `BATON_Architecture.md`: actual ABI and verifier policy; current single-task scope; implemented SQLite/authority status and correct module paths; trust in buyer gateway/key service/provider.
- [x] Update `README.md`, `test.md`, `docs/gates.md`, `status/` and `requests.md`: remove stale missing-module assertions, list actual commands, keep Node minimum consistent at the verified supported version, and distinguish local, live, historical and blocked proofs.
- [x] Reconcile the repository plan and owner commitments: `plan.md` is the only plan file; outstanding inputs are tracked in `requests.md`. Preserve the existing checkout and branch history.
- [x] Record local command, mode, base SHA, UTC timestamp, result and explicit no-live-write status. Record chain/Arkiv/host evidence only where it exists; the live job has not run.
- [x] Map each finding to its local regression evidence and give unresolved live requirements a separate blocked status. Fix commit links remain pending because this candidate is an uncommitted working tree.
- [ ] Record host separation, V2 block/hash/confirmation, transaction receipts, and Arkiv entity owner/expiry/inventory/digests after the live run. Exclude secrets and decryption keys.

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

| Finding | Local status and regression evidence | Live gate |
|---|---|---|
| F01 | `FIXED_LOCAL` — `server/contracts/test/JobEscrow.t.sol::testClaimThreeThenEarnAndClaimFour`, `testClaimsRemainAvailableAfterTakeoverAndClosure`; Foundry 17/17 | `BLOCKED` — deployed V2 claim/refund flow not exercised |
| F02 | `FIXED_LOCAL` — `testSharedCheckpointBoundaryFixtureCommitsItsHeadAndLocator`; `server/packages/storage/src/arkiv.test.ts` checks the exact signed envelope locator | `BLOCKED` — fresh checkpoint not written/accepted on live V2 and Arkiv |
| F03 | `FIXED_LOCAL` — `scripts/acceptance-local.mjs` restarts SQLite after settlement, lets B reuse and recover 30 bytes with the matching digest and one submission; worker/API tests cover signed reuse/retrieval, production route access and stale-A denial; `worker:paid-output:b` exposes the flow to a downstream consumer | `BLOCKED` — paid-service endpoints are absent; no real settlement or entitlement proof |
| F04 | `FIXED_LOCAL` — `server/src/services/gateway/gateway.test.ts`, `server/src/services/ledger/operationLedger.test.ts`, route and takeover-policy regressions cover drain/reconciliation/restart/head races | `BLOCKED` — buyer-only drain/takeover has not run against deployed V2 |
| F05 | `FIXED_LOCAL` — `server/services/provider/hederaX402.test.ts`, `hederaPaymentProvider.test.ts`, `arkivPaidOutput.test.ts`, plus SQLite actual-debit accounting | `BLOCKED` — real challenge, debit, paid output and Arkiv readback are unverified |
| F06 | `FIXED_LOCAL` — `server/src/chain/*.test.ts` and signed API routes cover actor/action/task/epoch binding and confirmed-state disagreement | `BLOCKED` — configured escrow is V1; no current V2 authority read or grant evidence |
| F07 | `FIXED_LOCAL` — shared checkpoint fixture, `server/apps/worker/src/acceptedCheckpointRecovery.test.ts`, storage recovery suite and key-service smoke cover locator/key/runtime boundaries | `BLOCKED` — no live accepted checkpoint, buyer signer or clean B host |
| F08 | `FIXED_LOCAL` — Foundry lifecycle/refund regressions and route tests cover contract/local transition rules | `BLOCKED` — revised V2 lifecycle and refund remain untested live |
| F09 | `FIXED_LOCAL` — signed operation/list/output and immutable task binding are tested in worker/API routes; MCP probe is implemented | `BLOCKED` — `.env.worker-b` lacks MCP endpoint/API key, so B-specific capability probing cannot run |
| F10 | `FIXED_LOCAL` — gateway and ledger regressions cover legal transitions, durable reservations, persistence recovery and one-time actual-debit accounting | `BLOCKED` — live provider and V2 interaction remain unverified |
| F11 | `FIXED_LOCAL` — enforced checkpoint/artifact/chunk/concurrency limits plus `server/packages/storage/src/retention.test.ts` cover bounded recovery and renewal logic locally | `BLOCKED` — no live Arkiv owner/expiry inventory or renewal after A stops |

## 12. First work session and stop conditions

Prioritize by evidence rather than a promised four-hour deadline:

1. **Baseline and contract block:** verify integration; fix F01/F02 and agree the shared fixture.
2. **Recovery block:** D2 proves real Arkiv bytes and scoped B import while D1 finishes authenticated authority and SQLite operation/accounting fixes.
3. **Payment/handoff block:** connect the actual provider, persist paid output, enforce durable drain and successor reuse.
4. **Release block:** deploy the repaired candidate, run the separate-host scenario and update claims from its evidence.

Stop the affected live gate when ENS binding is unresolved, provider settlement/output lookup is unavailable, Arkiv ownership/readback/retention fails, B lacks key/tool access, or B's independent host is unavailable. Continue independent local fixes and report the blocker. Do not replace a failed live dependency with a fixture and call integrated recovery complete.

**Completion:** all P0/P1 findings satisfy their release regressions and relevant live gates; remaining P2 limits are fixed or explicitly bounded and documented; the complete crash/recovery/payment scenario is reproducible from the exact candidate revision.

## 13. Current G0–G5 implementation progress — 6 November 2026

This update reconciles local integration commit `cfbee60` and Worker B environment fix `8b1e716` with upstream `build/audit-g0-g4` commits through `f28b296`. The separate `build/authority-payments` worktree was not modified. D1's `e1d7b2c` is an ancestor of this branch. `runtime-recovery-audit.md` and the audit's original probe scripts/data are not present here, so findings are reconstructed from the plan, code and recorded evidence.

| Gate | Implemented and locally evidenced | Still open |
|---|---|---|
| G0 | Branch/base and merged D1/D2 files reconciled; root `.env` and worker env loading checked without printing secret values; solc 0.8.28 remains pinned and uses `tmp@0.2.7`; `npm audit` reports zero advisories; latest API restart integration passes 1/1 | Complete external prerequisite confirmation |
| G1 | Cumulative withdrawals, accounting view, acceptance-spec separation, signed checkpoint fields, local JobStore deadline/parent/sequence validation, seventeen Foundry regressions under pinned solc 0.8.28, and a shared Solidity/TypeScript/storage/recovery boundary fixture | Deploy/review V2 and prove a fresh encrypted checkpoint and exact locator through the actual chain and Arkiv path |
| G2 | Action-scoped EIP-712 authorization, durable nonce replay prevention, buyer-signed pristine chain-job import, local buyer-signed accepted-checkpoint key grants, simulated/confirmed escrow writes for assignment, checkpoint acceptance, drain, pause, resume, and cancel-drain, worker-signed claim relay bound to exact chain/escrow/calldata, exact retry handling, task binding, confirmed multi-RPC reads with disagreement checks, authority recheck at provider boundary, fake-backed Arkiv candidate verifier | B-specific capability probe and live V2/Arkiv/RPC checks; the local grant command has not been run against a live accepted checkpoint |
| G3 | Exact-head recovery helper and `worker:recover:b` entry point; B independently compares confirmed chain state to the API snapshot, fetches/decrypts Arkiv content read-only, validates supported runtime state, and only then acknowledges. Combined worker suite passes 11/11; storage/key-service/retention coverage remains locally fake-backed. | Real accepted-checkpoint grant, clean-host live recovery, buyer-owned SDK write/read and renewal while A is stopped; tunnel only if B is cross-host |
| G4 | Stable provider contract, concrete configurable submit/status/output HTTP client, strict x402 v2 challenge selection, provider-reported actual debit accounting, encrypted Arkiv output pointer/readback, drain blocking until settlement output is available, and B's CLI path for signed discovery/reuse/output retrieval with digest verification. Provider tests pass 16/16, ledger 11/11, gateway 9/9, worker suite 11/11, and route/API tests cover the signed retrieval path. | Configure and confirm compatibility with the actual paid-service API; live settlement/finality evidence and A-to-B crash run |
| G5 | Buyer-side timeout policy, authenticated heartbeat and exact-head acknowledgement, durable drain/reconciliation barriers, buyer-only drain/cancel-drain/takeover writes, stale-worker fencing, and confirmed accepted-head refresh with B re-acknowledgement. Focused regressions pass 16/16; Foundry passes 17/17. | Live V2 verification, B's live grant and acknowledgement, and retry/reorg evidence |

Local candidate evidence: the merged tree passes `npm run verify` with 117/117 automated tests, client/server typecheck and production builds, Solidity compilation, signing vector and local acceptance; `forge test --root server/contracts --offline` passes 17/17. Its payment-crash scenario restarts SQLite after settlement; B reuses the operation, retrieves 30 bytes, verifies the digest and incurs no second submission. The B CLI flow has an end-to-end mocked test for signed discovery, reuse and retrieval. Other coverage includes payment uncertainty, accepted-head race recovery and re-acknowledgement, cancel-drain authorization, stale-worker rejection, the API job-provisioning restart journal, simulated Sepolia writer/claim-relay behavior, and contract acceptance of the shared checkpoint fixture. Route tests use in-process dispatch and fake provider/chain state. No live transaction, Arkiv write, or x402 payment was made in this verification pass. The historical 12/12 Foundry count is superseded by the current 17/17 run.

The API loads the ignored root `.env`; the buyer EVM deployer key matches `BUYER_SEPOLIA_SIGNER`, and both worker EVM keys match their configured addresses. Worker-specific Arkiv RPC/signers are present, but the API's generic `ARKIV_RPC_URL` and buyer-owned `ARKIV_SIGNER_PRIVATE_KEY` are absent, so Arkiv candidate verification is disabled. `.env.key-service` and separate `.env.worker-a` / `.env.worker-b` are present; the buyer-host service currently answers on loopback, but no accepted-checkpoint grant exists and B's host topology is unconfirmed. The historical live label remains **Sepolia lifecycle: LIVE_PASS; full integration: pending.** The configured escrow at `0x4f802976810690f984cd05640a23b3ffb5b395e1` has bytecode but no callable V2 `PROTOCOL_VERSION`; no V2 deployment or transaction was made. The complete contract lifecycle test plan is already prepared at `.baton-data/prepared-sepolia-v2-test-job.json` and waits for the replacement escrow.

## 14. Remaining local work that does not need `.env` changes

These are available local/code tasks. Live-network claims remain out of scope until their separate inputs and services are ready.

| Gate | Remaining work without editing `.env` |
|---|---|
| G0 | External prerequisite confirmation remains. The pinned dependency/compiler parity is restored (`solc@0.8.28`, `tmp@0.2.7`); `npm audit`, `npm run verify`, and the latest API restart integration pass. |
| G1 | The contract lifecycle, deadline, pause, withdrawal and refund suite passes 17/17 under pinned solc 0.8.28. A shared encrypted-envelope fixture now checks contract acceptance, TypeScript signing, and storage recovery; V2 deployment and real chain/Arkiv acceptance remain pending. |
| G2 | Production assignment/checkpoint/pause/resume routes now write through the buyer escrow signer and require confirmed post-write state before local updates. The Sepolia writer simulates calls and waits for confirmations; the claim route relays a worker-signed raw transaction only after verifying chain, target, calldata, value, and recovered sender, then reconciles per-worker accounting. Retry paths recognize an exact already-confirmed transition. Typecheck and fake-backed writer, route, authority, and gateway tests pass. Live verification remains blocked by the configured escrow being V1; the B-specific capability probe, live accepted-head grant, and real RPC/content reads remain open. |
| G3 | `recoverAcceptedPackage` is wired into candidate verification, confirmed accepted-head refresh and the B `recover-accepted` CLI. Local tests cover chain-head mismatch, bad runtime import and acknowledgement ordering; Arkiv recovery can run without the buyer signer. Still needed: exact live accepted-head grant, real buyer-owned writes/readback and renewal while A is stopped. |
| G4 | Provider/network/payee/policy identity remains in the stable fingerprint. Local x402 tests enforce challenge bindings and settlement evidence; SQLite accounts for actual debit and returns unused reservation; Arkiv paid-output storage/readback and provider reconciliation are composed behind a configurable HTTP client. Worker B signs operation discovery, reuse and output retrieval, then verifies the retrieved bytes against the durable digest. Submit idempotency, definitive-vs-unknown status, bounded output recovery and operation-bound output responses are covered with fakes. SETTLED operations block drain until output recovery completes. Still needed: actual provider endpoint compatibility/configuration and live evidence. |
| G5 | Buyer policy, drain/reconciliation, buyer-only takeover writer, cancel-drain, confirmed accepted-head refresh and B re-acknowledgement pass focused local checks. The live V2 grant/acknowledgement and reorg path remain open. |

The remaining live requirements are tracked separately: a configured buyer-owned Arkiv signer and generic server RPC, provider submit/status/output endpoints, a live checkpoint grant, buyer-owned entity retention, B's host topology and MCP endpoint/credential, confirmed V2 chain state, and a real provider that confirms the adapter's idempotency and entitlement behavior. Add a temporary tunnel only for cross-host workers. The local HTTP restart integration and compiler/dependency checks now pass.
