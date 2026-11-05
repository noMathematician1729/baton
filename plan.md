# BATON: 24-hour end-to-end build plan

Two developers working in parallel. Clock: H00:00 is the agreed start; H24:00 is the delivery deadline. Record the actual start and all needed-by times in Asia/Kolkata. There is no assumed time after hour 24. Hours 20–24 are reserved for repairs, fresh-machine runs and rehearsal.

Deliver a running BATON with live Sepolia rewards/ENS authority, Arkiv checkpoint recovery and Hedera x402 service payments. Ship code, repeatable setup, executable acceptance scenarios, a continuously updated README and a recorded fresh-job demonstration. The target includes bounded working examples of every feature family in the context, rather than deferring task graphs, capability matching, quantitative state and large-artifact recovery.

## 1. What must work at hour 24

### Main demonstration: work, authority and money survive A

1. Buyer creates a job with three batch milestones priced at 3/3/4 test tokens and a separately funded Hedera service budget. The agreed terms identify the buyer as demo verifier.
2. Signed candidate profiles and a tool probe establish that A can execute the task. Buyer assigns A and provides its scoped ENS grant. Assignment requires worker consent to the frozen terms.
3. A buys batch 1 through a real Hedera x402 endpoint, processes it and exports an encrypted checkpoint to Arkiv. Buyer verifies the output, reads back the ciphertext/mirror, accepts the milestone and credits A with 3 tokens.
4. A is terminated. B starts on another machine with no A work directory, tool credentials, runtime cache or payer private key.
5. Buyer drains task spending; B recovers the exact accepted manifest, verifies required artifacts and passes capability/tool admission with its own access. B signs an exact-head acknowledgement. Buyer grants B, takes over, waits for the configured confirmation threshold and opens the gateway for B's new epoch.
6. B completes batches 2–3. Its different implementation produces the same accepted output. A withdraws 3; B withdraws 7. Neither worker transfers rewards to the other.
7. Submit A's saved old-epoch offer and service request. Both fail. Show the accepted head, epoch, paid-operation receipts and actual withdrawal transactions.

### Additional runnable demonstration modes

| Mode | Working feature and human-visible outcome |
|---|---|
| Payment crash | A settles batch 2, then dies before checkpoint acceptance. B retrieves the paid output from the independent ledger/provider, without a second debit. |
| Unknown payment | Lose the settlement response. Reservation remains held; repeat request blocks or reconciles. Restart the gateway and prove the same operation survives. |
| Large artifacts and cold recovery | Reference an encrypted, chunked synthetic corpus of at least 8 MiB; write a compact Arkiv manifest, reuse unchanged chunks across a delta checkpoint, then recover with an empty runtime cache. Report measured bytes; do not call this a measured 1.5M-token session. |
| Mirror recovery | Disable Arkiv reads after a valid acceptance. B recovers the matching mirror; corrupt the mirror too and show recovery blocks. |
| Tool/MCP portability | B lacks required authorization or uses an incompatible schema: admission refuses takeover. Grant B its own scoped access; the MCP probe and approved alternative implementation pass. |
| Matchmaking and delegation | A small fixed DAG has two independent ready subtasks and one dependent aggregate. Show eligible candidates, conformance evidence and selection; activate the aggregate only with exact accepted dependency commitments. Each task has its own epoch, head and rewards. |
| Quantitative state | Export/import a Beta-Bernoulli estimator's counts, prior, input snapshot and posterior. B continues on the remaining observations. Posterior matches an uninterrupted reference run. Reject incompatible adapter versions. This demonstrates probabilistic-state continuation; it is not a claimed Jev integration. |
| Approval and pricing | A 30%-progress milestone has a pre-agreed 10%-reward allocation. Reject an output failing its acceptance rule; accept a different valid approach. Previously accepted credit cannot be vetoed or rewritten. |
| Lifecycle | Buyer pause/resume, unauthorized approval, ENS grant revocation, timeout closure, unused-fund refund and claims after closure all have runnable checks. |

The paid endpoint may be self-hosted synthetic data/compute, disclosed in the UI and demo. The Hedera settlement itself must be real. Demonstrate rights and capability boundaries using controlled fixtures; do not claim connectivity to actual Corp X/Y or arbitrary corporate tools. Provider prompt caches are not migrated; recovery runs cold from durable artifacts.

## 2. Parallel ownership and working agreement

Both developers receive this same plan. At startup set `EXECUTION_ROLE=D1` or `D2` in the local session and follow the corresponding column. Each developer may use their own coding assistant. This plan does not require spawning additional agents.

| Owner | Owns and implements | Must publish for the other developer |
|---|---|---|
| D1: authority, rewards, spending | Solidity escrow/task graph, ENS adapter, typed signatures, reward token/deployment, gateway authorization/drain, transactional spending ledger, chain readers and buyer transaction controls | Protocol skeleton by H00:30; signed hash vectors by H02; generated ABI by H04; local contract/gateway adapters by H06; deployed live addresses and full spending integration by H08 |
| D2: execution, recovery, usable demo | Arkiv/artifact/mirror storage, export/import runtime, deterministic/quantitative adapters, paid x402 provider/client adapter, MCP tool service, admission/ranking, workers, dashboard and demo runner | Checkpoint/tool schemas by H00:30; data fixtures and reference outputs by H02; proven storage and x402 adapters by H04; full worker/provider interfaces by H06; dashboard/readme and executable human scenarios at every gate |
| Joint, time-boxed | Shared interface freeze, two-host integration, cross-review of critical code, gate acceptance and final fresh-job rehearsal | 10–15-minute integration at H02, H04, H06, H08, H10, H12, H16, H20, H22 and H24; no long meetings |

D1 owns `contracts/`, `services/gateway/`, `services/ledger/`, `packages/chain/` and `deployments/`. D2 owns `packages/checkpoint/`, `packages/storage/`, `packages/runtime/`, `services/provider/`, `services/tools/`, `services/admission/`, `apps/worker/`, `apps/console/` and `scripts/scenarios/`. D1 owns protocol/signing definitions; D2 owns checkpoint/adapter definitions. Publish shared schemas together at H01 and thereafter change them only with both developers' acknowledgement plus an updated fixture.

Use branches/worktrees `build/authority-payments` and `build/runtime-recovery`. Merge small passing changes at least every two hours. D1 merges chain/gateway changes; D2 merges runtime/UI changes; rebase before editing shared lockfiles. Pin one package manager and commit the lockfile. Neither developer edits the other's directories without a coordinated handoff. Cross-review security-sensitive changes before deployment, not every cosmetic patch.

### D1 gateway and environment update — 2026-11-06

**Sepolia lifecycle: LIVE_PASS; full integration: pending.** The funded lifecycle and its evidence below remain the Sepolia regression baseline.

D1 has wired a read-only Sepolia authority reader into gateway assignment, milestone acceptance, takeover/resume, and paid-operation admission. It verifies the configured escrow/adapter, Sepolia chain ID, buyer, active worker/epoch, grant, cutoff, and open/drained/paused/closed state. The gateway serializes drain against work and enforces approved services, available budget, and per-request caps before provider submission. Local acceptance passes the mocked stale/revoked-worker and over-cap cases, UNKNOWN retry without resubmission, and a simulated payment-crash recovery where B reuses A's settled output with one provider submission. These are local checks; the gateway has not yet run against a fresh live job or real payment provider.

The operator configured Worker A's Arkiv signer in the ignored checkout `.env`; its derived public address matches Worker A. The root `.env` has no `ARKIV_ACCESS_KEY`, and this checkout has no worker-specific env files. The server loads root `.env` through `dotenv`, where inherited process variables take precedence. The restricted execution shell could not inspect or stop the existing API process (`EPERM`), so restart and inherited-variable verification remain with the owning Mac Terminal session.

Remaining live gates: add the intended worker's Arkiv access key privately; define Arkiv entity ownership/renewal; run a real purchase, Arkiv checkpoint, Sepolia acceptance, A termination, and B recovery; then repeat payment-crash against the provider's durable idempotency record. On 2026-11-06, `build/runtime-recovery` was fetched and merged into `build/authority-payments`. The merge retained D1's Sepolia scripts/evidence and combined the SQLite ledger with D1 authority and worker/epoch checks. Merged-tree typecheck/build, contract compile, signing, local acceptance, and all 15 non-HTTP tests pass. The API restart test is blocked by the sandbox's loopback `EPERM`, and the standard `tsx` launcher cannot create its IPC socket; no new live payment or content write was performed.

Independence means both can code against fixed types, fixtures and adapters while live dependencies are prepared. Integration still requires the short shared gates. Waiting for an ABI, account or endpoint is not an instruction to stop: continue local contract tests, reference adapters, fixtures or UI against the same interface.

### D1 progress snapshot — 2026-11-06 (Asia/Kolkata)

This snapshot records D1's work only. D2 should add or update a separate D2 snapshot without replacing this section.

**Completed by D1**

- Protocol/signing foundation: versioned protocol types, canonical hashing, EIP-712 offer/takeover helpers and signing-vector coverage.
- Local authority/payment path: `JobEscrow` and `JobAuthority` sources, durable reservation/settlement/UNKNOWN/reconciliation ledger, epoch/drain fencing, local milestone lifecycle and acceptance scenario. The gateway now reads Sepolia escrow/adapter state for worker, epoch, scoped grant and open/drain checks; it serializes drain with requests and enforces service allowlists, balance reservations and per-request caps.
- ENS authority adapter: `JobAuthority` reads the ENSv2 Permissioned Resolver's `roles(resource, account)` and checks `ROLE_SET_DATA` at the resource derived from `baton.job.v1:<lowercase-job-id>`. The user reports the live grant/revoke/wrong-job checks passed for adapter `0xD659F372D2439075F29e39f5E005d86352Da1A6c`; the resolver and adapter remain separate in local `.env`.
- Escrow redeploy workflow: `JobEscrow` has a zero-argument constructor. Added an explicit replace command that checks the configured resolver and adapter, verifies Sepolia chain ID, waits for the deployment receipt, checks runtime code, then updates `BATON_ESCROW_ADDRESS` while preserving `.env` mode `0600`.
- Worker authority workflow: configured the user's actual Worker A/B public addresses in ignored `.env` and added a script to test each worker's temporary scoped grant, wrong-job denial, and revoke through the deployed adapter.
- Funded job lifecycle: completed a live Sepolia run against the configured escrow using a test-only mintable ERC-20. A received and withdrew 3 tokens; after takeover to B at epoch 2, B received and withdrew 7. Escrow ended at zero. Stale A was rejected with `StaleEpoch` in an `eth_call` simulation. All 17 submitted transactions had successful receipts with two confirmations. Worker A's signer was configured privately and matched its public address. Full evidence is in `evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json`.
- Contract build: Solidity 0.8.28 compilation and generated tracked ABIs.
- Earlier escrow deployment: `JobEscrow` at `0x141FA2cE7805d87AEb363a2A725CAa0A0E945deC` has a recorded receipt at `0xeb56aa6e3020bbcdf4dc146bcfa2a3cba3e86474820d77709a75822df32ddfb7`; this address is superseded by the current local setting.
- Current local escrow setting: `BATON_ESCROW_ADDRESS=0x4F802976810690F984cd05640a23b3FFB5B395E1`; reuse this address for the funded job and do not redeploy it. The current deployment transaction hash is not in tracked evidence.
- D1's Sepolia lifecycle and public evidence are pushed to `build/authority-payments` at commit `9d09feb`.
- D1's Sepolia authority reader and local gateway recovery changes are pushed to `build/authority-payments` at commit `8c1f09c86154ae20bc2eb7d7bc9d517f144a1ce5`; this is the D2 handoff reference.
- Gateway regression: local mock authority rejects stale/revoked workers and over-cap requests before provider calls; UNKNOWN retries do not resubmit; a simulated post-settlement crash reopens stores and lets B reuse A's output with one provider submission. This is local simulation, not live Hedera x402 proof.

**Operator-side inputs verified**

- Configured Sepolia RPC returned chain ID `11155111`; `baton.eth` resolved to buyer address `0x0f35bDe4F4b1270813c5116DA20915FCD49e47FA`, matching the locally configured deployer.
- Deployer credentials stayed in ignored local `.env`, which has mode `0600`; no secret value was copied into the repository or chat.
- `ARKIV_SIGNER_PRIVATE_KEY` derives to Worker A `0x432Eeff3E312f1910F3D04A6449753306fFaA5D2`. `ARKIV_ACCESS_KEY` is missing from the checkout root `.env`; no worker-specific env files were found. The server loads that root `.env`, while inherited process variables take precedence. The restricted shell could not inspect or stop the running API process (`EPERM`), so restart and effective-process verification remain for the owning Mac Terminal session.

**Remaining for D1**

- Run the Sepolia-bound gateway against a fresh open job; current gateway tests use a mocked chain reader and do not prove live gateway behavior.
- Add the intended worker's Arkiv access key privately, then verify effective env configuration and restart the API.
- Integrate D2's Arkiv, Hedera x402 provider and durable ledger; configure a live endpoint and prove a settlement with a retrievable output.

**Joint remaining work**

- Integrate D1's live authority path with D2's Arkiv checkpoint, Hedera x402 provider, worker and recovery path on two hosts; run the real purchase → Arkiv checkpoint → Sepolia acceptance → A termination → B recovery flow. Then repeat payment-crash with provider idempotency and record evidence.

**Readiness:** **Sepolia lifecycle: LIVE_PASS; full integration: pending.** The live reward run used a test-only token. D1's authority reader and gateway recovery scenarios pass locally, while real gateway execution, Arkiv writes and Hedera x402 settlement remain open. Track completion by gates and evidence rather than an unweighted percentage.

## 3. Stack, setup and external dependency gates

Use TypeScript/viem, Solidity/Foundry/OpenZeppelin, one minimal web console, one buyer backend, SQLite with durable transactions, and a pinned compatible Arkiv SDK/x402 starter. Prefer installed tools; Docker is optional. At H00 inspect actual installed versions and pin the compatible set rather than pulling floating latest versions mid-build. The x402 starter is alpha and version-sensitive: pin its exact commit and supported payment scheme after a successful live request.

| Check | D1 | D2 | Pass evidence by H04 |
|---|---|---|---|
| Repository and both machines | Verify write access, Git/toolchain, local Anvil, shared protocol and ignored secrets | Verify build on B's laptop, isolated worker dirs, reachable buyer backend | Both run the same tagged skeleton and tests |
| Sepolia identities | Verify Buyer/A/B public addresses, chain IDs, test ETH, reward-token deployment/signers | Connect worker signers without copying keys between workers | Safe signing check and correct account labels |
| ENS | Resolve exact buyer-owned name; inspect deployed registry/resolver bytecode, ABI and live permissions; prove grant/revoke and contract-readable check | Consume adapter and show scope in admission/UI | Actual name, chain, resolver/version, grant/revoke receipts and pinned authority query |
| Arkiv | Review manifest hash commitment fields | Actual encrypted write, exact-entity read, expiry check and extension path; independent mirror | Entity/transaction IDs and matching decrypted digest |
| Hedera | Verify gateway payer/facilitator/payee roles and service budget | Prove selected asset/scheme through 402 → settlement → durable retrievable output | Network transaction ID, receipt, payer/payee and output digest |
| Persistence and hosts | Durable gateway SQLite path on buyer host; one process, safe serialized admission/drain | Separate provider ledger and artifact/mirror paths; B reaches services without A | Buyer/provider restart preserves state; disabling A does not kill services |

Previously reported setup includes three Sepolia wallets, Arkiv funding/access, a Hedera account, ENS registration and Foundry. Treat those as reported readiness until tested; do not ask users to recreate existing accounts. Check teammate setup independently. Do not repeat or expose secrets. Revoke/replace any key already known to have been exposed before use.

Public configuration: network IDs, contract/registry/resolver addresses, exact ENS name, role addresses, URLs without credentials, schema/adapter versions and confirmation policy. Private configuration: RPC credentials, signer references, Arkiv access, gateway Hedera key, MCP tokens and content-key store. Keep keys in per-host env/keystore, never README or checkpoint. Buyer transactions use explicit wallet approvals; workers cannot approve their own milestones. A teammate building code does not need ENS ownership.

ENS is an early integration risk: an ordinary name registration does not establish the required scoped permissions. Inspect the actual testnet deployment using current official deployment docs. If incompatible, immediately provision the required job-scoped binding on the supported deployment with the buyer. Do not silently substitute an ENS text record or mock authority check. An unresolved real integration blocks the corresponding live gate.

## 4. First-hour interface contract

By H00:30 each owner publishes a typed stub with deterministic fixtures. By H01 freeze `protocol/v1` and one cross-language signing vector. These are local fixture implementations, clearly labelled; production/testnet mode must refuse them.

| Interface | Required behavior |
|---|---|
| Job/Task | Freeze terms, task IDs, DAG edges, prices, verifier, cutoff and capability policy before funding. Use per-task assignment/epoch/head, even in the single-task demo. |
| Dependency binding | Freeze dependency task IDs at creation; bind their actual accepted output commitments when downstream work activates. Outputs do not exist at initial funding. Reject stale or unaccepted dependency versions. |
| MilestoneOffer | Distinct EIP-712 action/domain; job/task, terms, producer, epoch, milestone, expected head, new checkpoint commitment, nonce and expiry. Reward comes from the frozen schedule. |
| TakeoverAck | B signs job/task, terms, current epoch, exact head, compatibility report, service policy and expiry. Verify B's consent and live grant before reassignment. |
| StorageAdapter | `stage`, `readExact`, `verifyArtifacts`, `mirror`, `extendRetention`; exact serialization/digests, encryption associated data and error codes. |
| RuntimeAdapter | `probe`, `exportState`, `importState`, `runNext`, `verify`; explicit versions; fail incompatible imports. |
| PaidOperation | Stable logical key `(job, task, service, inputDigest)` across retries/epochs; separate signed request binds worker, epoch, nonce, policy and expiry. Same key/different input fails. |
| Gateway | `quote`, `execute`, `status`, `recoverOutput`, `drainTask`, `reconcile`, `resumeTask`; authenticated admin/worker boundaries and durable state transitions. |
| Admission | Signed profiles → hard eligibility → real tool/adapter conformance → evidence-backed ranking → buyer choice. It never assigns contract authority itself. |

Use integer base units. Include explicit empty-head encoding, canonical JSON byte encoding, digest algorithm and nonce semantics in protocol fixtures. Generate TS contract bindings from ABI. Compare a TS-signed offer and Solidity recovered signer by H04; this precedes any full-flow debugging.

## 5. The 24-hour execution schedule

Each block includes implementation, tests and the README update; documentation is not saved until the end. Prepare the next block's external inputs while the current one runs.

| Hours | D1: authority/payments | D2: execution/recovery | Integrated result and release gate |
|---|---|---|---|
| H00–H01 | Inspect setup; skeleton contracts/ENS/gateway interfaces; publish chain stubs and role policy | Inspect A/B hosts; workspace/run scripts; checkpoint/runtime/provider stubs; initialize README and status files | G0: both install/start skeleton, agreed schema fixtures, all missing inputs queued |
| H01–H02 | Core fund/assign/accept/claim locally; terms and per-task state; first signature vector | Batch fixture + reference verifier; local encrypted checkpoint/mirror; minimal status page and worker commands | G1: buyer creates a local job; A produces/verifies a local checkpoint; page shows job/worker/head |
| H02–H04 | ENS live grant/revoke proof; contract signature/credit tests; initial DAG/dependency structure; ABI export | Actual Arkiv round-trip; actual Hedera x402 purchase; provider paid-output lookup; isolated B recovery | G2: three independent live integration proofs, same shared types, ciphertext verified from B; save receipt evidence |
| H04–H06 | Deploy tested Sepolia candidate; transactional operation ledger/reservations; signed gateway auth and cap checks | A worker connects paid adapter, computation, Arkiv and mirror; buyer evidence review and consent; MCP probe skeleton | G3: complete local milestone flow through actual app interfaces, with real adapters independently proven; contract/type integration passes |
| H06–H08 | Live gateway current-state/ENS checks, fee allowances, settlement reconciliation and ledger restart | Wire A end-to-end with real networks; display service/reward balances separately; acceptance UI and claims | G4: one live paid batch yields one real accepted checkpoint and 3-token credit; README can reproduce it |
| H08–H10 | Exact-head takeover, per-task epoch, drain/reopen, confirmed-state checks and stale-request rejection | B recovery/admission, private key access, own MCP connection, alternate implementation; acknowledgement signing | G5: human kills A and B resumes on second laptop; stale A work/spend fails |
| H10–H12 | Finish claim/refund/pause boundaries; ensure service purchases/rewards conserve funds; review B recovery | Complete remaining batches and final verification; automate ordinary handoff/reset; receipts/UI polish sufficient for use | G6: full live main demo with A=3/B=7 withdrawals and correct output; create rollback tag |
| H12–H14 | Crash/UNKNOWN/reconciliation and concurrent-reservation tests; durable drain; recover after gateway restart | Provider idempotency/output entitlement, crash injection after payment, mirror/corruption/key tests | G7: paid batch survives A failure with one settlement; restart/unknown/mirror modes executable |
| H14–H16 | Complete bounded DAG fixture, independent task authority and dependency pinning; uneven reward fixture; verifier veto tests | Signed capability profiles/ranking and unauthorized MCP rejection; Beta-Bernoulli adapter export/import; chunk/delta store and retention monitor | G8: all additional feature modes run locally through real app/contract interfaces; no feature-family omission |
| H16–H18 | Integrate DAG and pricing modes with deployed contracts; exercise ENS revocation/current-state failures; cross-review ledger/storage | Run tool admission, quantitative and artifact modes against live storage where applicable; cross-review signatures/authority | G9: feature matrix populated with commands, outcomes and live/local evidence; resolve mismatches with architecture |
| H18–H20 | Full local adversarial suite + live money/authority regression; fix blocking issues; deployment manifest freeze | Full human walkthrough on B; fix UX/README/reset; capture live evidence for each applicable mode | G10: feature freeze, mandatory scenarios pass, fresh-job scripts and status dashboard reliable |
| H20–H22 | Repair defects only; verify final addresses/balances, payouts/refunds; review chain evidence | Clean checkout/start on B from README, ordinary + payment-crash + advanced scenario walkthroughs; record | G11: reproducible fresh setup on second machine; final candidate tag and demo video |
| H22–H24 | Last regression against exact tagged deployment; standby for network repairs | Rehearse 8–10-minute main demo plus optional feature views; package README/evidence/reset instructions | G12: final commit, both live withdrawals, receipt links, tested feature matrix, video and runnable handover |

This is an aggressive target for two developers: mitigate with narrow fixtures, early live probes and a CLI fallback, not claims that 24 hours guarantees every external dependency. If a gate fails, publish the exact failed scenario/owner immediately, repair against the last good tag and use the H20–H24 reserve. Do not silently remove a required feature or replace a live claim with a mock. Escalate projected overrun at H04/H08/H12 while there is still time to act.

## 6. Human checkpoints: runnable versions, not status reports

Create the following root scripts during the build. The names below are the required command contract for the repository, not a claim that scripts already exist in this planning artifact. `pnpm human --gate Gx` prints exact URLs, prerequisites, expected state changes and a pass/fail record. Each command has explicit `--mode local|testnet`; never infer the network from an undocumented default. Destructive local resets require a selected run ID; testnet reset creates a new job and preserves old evidence.

| Gate / deadline | Human action | Expected observation |
|---|---|---|
| G1 / H02 | `pnpm demo:local`; open console and create local job; run A | A visible job, fixed terms, verified checkpoint, no wallet/networks needed to inspect local flow |
| G2 / H04 | `pnpm smoke:testnet`; inspect ENS, Arkiv and Hedera receipt links | Actual network IDs, grant/revoke results, encrypted entity digest and settled paid output |
| G4 / H08 | `pnpm demo:milestone -- --mode testnet`; approve Buyer action | Batch 1 accepted; reward credit 3; service spend shown in a distinct asset/budget |
| G5 / H10 | `pnpm demo:handoff -- --mode testnet`; stop only A; approve B takeover | B resumes from confirmed head on host B; no A directory mounted; old epoch requests rejected |
| G6 / H12 | Finish main job and click each worker's Claim control | Correct final artifact; actual A/B wallet changes of 3/7 reward tokens; zero remaining reward allocation |
| G7 / H14 | `pnpm demo:payment-crash`; `pnpm demo:unknown`; `pnpm demo:mirror` with explicit mode | One settled purchase reused; UNKNOWN retains reservation; mirror works; corrupt copies block |
| G8 / H16 | `pnpm demo:capabilities`; `pnpm demo:quant`; `pnpm demo:artifacts`; `pnpm demo:dag`; `pnpm demo:pricing` | Permission failure then fresh access; matching evidence; identical posterior; bounded manifest/reused chunks; independent task epochs; 30% progress/10% reward |
| G10 / H20 | `pnpm verify`; `pnpm test:e2e -- --mode testnet` | Machine-readable feature report; documented local fault tests and real-network receipts |
| G11 / H22 | Follow README from clean checkout on B and run fresh job | No hidden dependency on A's files or developer shell history; correct startup/order/network labels |
| G12 / H24 | Run timed judge walkthrough from tagged commit | Main flow fits 8–10 minutes; advanced modes and evidence accessible; reset demonstrated |

After each gate send a brief update: “Working now: … / Test it: URL + command / Expected: … / Next working gate: … / Input needed by: …”. Human confirmation is recorded separately from automated pass. If humans are unavailable, preserve the runnable gate and queue their check; do not label it human-tested.

## 7. Requirements-to-tests map

| Requirement | Owner | Mandatory assertions / completion evidence |
|---|---|---|
| Reward escrow and consent | D1 | Exact-transfer token; initial/replacement consent; 3/3/4 credited once; accepted producer retains credit; no A→B transfer; claims cannot double-withdraw |
| ENS authority | D1 | Live job grant; wrong/missing/revoked grant and changed resolver fail closed; task assignment remains required even if grant exists |
| Signed head and epoch | D1 | Wrong domain/contract/job/task/head/epoch/action/terms, expiry and replay fail; TS/Solidity vector matches; both accept-vs-takeover race orders preserve head/credits |
| Encrypted Arkiv recovery | D2 | Exact accepted entity; authenticated decryption and byte/hash check; newer unaccepted upload ignored; mirror/key availability checked before acceptance |
| Large-state handling | D2 | Chunk hashes, dedup/delta plus periodic full snapshot; bounded reconstruction; missing base/chunk blocks; corruption fails; selective loading measured; retained source remains available |
| Retention | D2 | Expiry monitor identifies near-expiry entities; extension works under buyer-controlled permission. Simulate expiry locally; do not wait days to test it |
| MCP and tool substitution | D2 | B's token is independent; missing scope/schema blocks; fresh scoped token passes; alternative implementation passes agreed conformance; no credentials in exported state |
| Cache continuity | D2 | Empty process/provider cache at B; task still completes from durable state; stale application tool results invalidated by input/tool/version/freshness changes |
| Paid service and budget | D1 + D2 | Real Hedera settlement; approved asset/payee/price; serialized reservations; duplicate IDs/nonces fail or retrieve; no double settlement from concurrent requests |
| Payment uncertainty | D1 + D2 | Kill before/after submission, after settlement and before output persistence; UNKNOWN holds reservation; durable provider record resolves output; no automatic blind repay |
| Drain and external authority | D1 | Persist drain with reservation transaction; restart drained; B blocked before assignment; A blocked after confirmed epoch; uncertain RPC/reorg closes admissions; submitted external actions remain tracked |
| Capability matching | D2 | Signed profiles; ineligible candidate filtered despite high score; independent conformance evidence; rank never grants authority; buyer selects |
| Probabilistic continuation | D2 | Beta prior/counts + exact dataset snapshot + adapter version recovered; resumed posterior equals reference; incompatible/missing state rejected; no single-outcome correctness claim |
| Multi-task delegation | D1 + D2 | Reject cyclic/unknown dependency graphs; independent task heads/epochs; downstream task cannot start before accepted dependencies; pin actual output commitments at activation |
| Veto and pricing | D1 + D2 | Named verifier rejects invalid work, accepts alternate valid method; price frozen; 30%/10% fixture; accepted credits cannot be revoked by buyer or workers |
| Pause/cutoff/refund | D1 | Paused acceptance/takeover fails; gateway drain separate; close refunds only unused allocation; accepted claims survive pause/closure; no new work after cutoff |
| Two-host runtime | D2 | A dies without taking down buyer/provider/mirror; B uses its own signer and connection; artifact import verified; final output matches reference |

For reward accounting assert: funded = unallocated + outstanding credits + outstanding refunds + withdrawn. For each service asset assert: deposits = available + reserved + settled spend + returned funds. Model gas/network fees explicitly in their own asset ledger where applicable. Test concurrent requests against job-wide and per-task caps. Unit/fault tests run locally; testnet runs prove actual provider integration. Do not pay for hundreds of fault-test runs on testnets.

At H18 run the cross-review: D1 reads D2's exact-head/key/import/output recovery; D2 reads D1's signature/current-state/reservation/withdrawal logic. Focus on trust boundaries and fail-closed behavior. A green unit suite does not replace a fresh live run after a contract change.

## 8. Implementation details that prevent integration surprises

### Spending and takeover

One buyer-host gateway holds payer authority. Use SQLite transactions and unique operation/nonces; reserve maximum debit before any outbound payment. Persist intent, request fingerprint, worker/epoch, provider receipt and output digest. UNKNOWN never frees funds based on a timeout alone. The provider also durably maps stable operation IDs to payment/output and authorizes buyer-approved successor access.

Handoff order: drain task admissions → reconcile pending operations → B reads confirmed head and imports state → B passes probes and signs → Buyer grants B and submits takeover → wait/re-read confirmed state → reopen for B. A failed or raced takeover leaves spending drained. Separate job pause from gateway drain so takeover is not accidentally blocked by pause. Changing an epoch cannot undo already submitted external transactions.

### Storage and keys

Standard authenticated encryption, fresh nonces, and job/task/schema associated data. Public Arkiv fields contain only non-sensitive discovery attributes and ciphertext; keys remain buyer-controlled. A staging upload is not canonical until accepted. Verify independent artifact/mirror availability first. A matching mirror does not authorize B to decrypt; issue B a separate scoped key grant through the buyer. No A private key handoff.

Chunk/delta engine: fixed-size encrypted chunks, content digests and a versioned manifest. A delta references exact base snapshots; make a full snapshot after a small bounded number of deltas (for example every three) and retain all reachable bases. Measure a target manifest <=64 KiB only if the pinned deployment permits it; otherwise lower the internal cap based on the live probe. That target is not a claimed Arkiv maximum. Avoid logging sensitive plaintext.

### Quantitative and multi-task demonstrations

Use a Beta(1,1) prior, a fixed binary dataset and explicit processed observation IDs. A exports alpha/beta or equivalent sufficient statistics plus snapshot digest and processed IDs; B processes remaining IDs once. Compare with the uninterrupted reference posterior. The adapter proves continuation of that model; it does not prove a universal Jev adapter or future predictive success.

For DAG mode use two independent ready tasks (batch aggregation and a quantitative summary), then a downstream report task. A and B work the ready tasks with separate authority; Buyer approves each. The report task binds their accepted outputs at activation. Pre-agree all task reward allocations and their sum; no new unbudgeted subcontracting and no worker-to-worker payment mechanism are introduced.

## 9. README as the live control panel

Start with the accompanying README.md. During implementation the repository README, not a chat transcript, becomes the current operational reference. D2 owns its structure; D1 updates its own machine-readable status file. Keep ownership separated so both can update in parallel without merge contention.

Create `status/d1.json` and `status/d2.json` with: owner, updatedAt, elapsedHours, currentTask, completedFeatures, nextGate, blockers, neededInputs and evidenceRefs. Each developer updates only their file. A D2-owned `pnpm status:refresh` merges them into a generated README status block without overwriting setup or demo instructions. Keep human observations and acceptance history in `docs/gates.md`. No secrets in status/evidence.

Update the status on every gate, deployment, blocker, interface change and completed human test, and at least hourly while building. Show: what works now, exact tested commit/network, how to try it, next testable feature/deadline, blocked input/owner and limitations. Never mark a feature passed merely because its code exists.

Use feature states `QUEUED`, `BUILDING`, `LOCAL_PASS`, `LIVE_PASS`, `HUMAN_PASS`, `BLOCKED`. Store mode, commit, timestamp and evidence with each test, so a later code change cannot inherit an unrelated pass. Local-only correctness scenarios such as simulated RPC reorg need not pretend to be live network experiments. If README status is over 60 minutes old, display STALE. At each two-hour tag, regenerate the status/report and save the exact configuration manifest.

README sections: quick start; current status; owner table; services/ports; public deployment manifest; env variable names; standard/fault/advanced demos; expected outcomes; test commands/results; trust dependencies; troubleshooting/reset. Link `plan.md` for full work allocation. Store receipts under `evidence/<runId>/` with redacted logs, job/task IDs, chain/contract addresses, Arkiv entity/digests, settlement/withdrawal IDs, assertions, commit and human checks. Keep secret-bearing RPC URLs out.

## 10. Request missing inputs 30 minutes before use

Maintain a rolling 60-minute lookahead in the active coding sessions. Request foreseeable missing configuration, wallet actions and human availability at least 30 minutes before first use. At startup bundle missing inputs; use H00–H00:30 for preparation while both developers scaffold. For late-discovered blockers notify immediately and name the gate at risk.

Create `requests.md` with ID, requester, responsible person, item/action, requestedAt, neededBy, affectedGate and state (`REQUESTED`, `READY`, `VERIFIED`, `BLOCKED`). Record both Hxx:xx and Asia/Kolkata time after T0 is set. Check the queue before asking again. Secret values go directly into the correct local env/keystore; ask for confirmation, not the secret in chat. Configuration is VERIFIED only after a safe connectivity/signing check.

| Latest heads-up | Needed by | Owner/preparer | Input or action | Independent work continues |
|---|---|---|---|---|
| H00:00 | H00:30 | Humans, coordinated by each developer | Existing repo access, public addresses, exact ENS name, configured RPC/Arkiv/Hedera credentials and signer availability | Skeletons, fixtures, local tests |
| H00:00 | H00:30 | D1/D2 | Typed interface stubs and checkpoint schemas | Contract/runtime code against agreed fixtures |
| H00:30 | H01:00 | B operator + D2 | B host connectivity, separate work directory, reachable buyer/mirror/tool endpoints | Storage/adapter implementation |
| H01:00 | H01:30 | Buyer + D1 | Availability for ENS grant/revoke and token/deployment transactions | Local signatures and contract tests |
| H03:00 | H03:30 | D1/D2 | ABI/signing vectors and proven provider adapter contract | Gateway/worker code against same adapters |
| H05:30 | H06:00 | Buyer + D1 | Funding and service-budget approvals for live flow | End-to-end local and artifact readback |
| H07:30 | H08:00 | Buyer/B operators + D2 | B key/tool access and availability for exact-head takeover | B import/conformance and race tests |
| H11:30 | H12:00 | Both humans | Payment-crash and restart test availability | Fault injection and durable ledger checks |
| H15:30 | H16:00 | Buyer + D1 | Ready signer/funds for live DAG/pricing fixture | Local advanced scenario coverage |
| H19:30 | H20:00 | Both humans | Clean-machine run, balances, recording, available B host | Regression, evidence packaging |

Suggested progress message: “PREP R07 — Needed by H08:00 / [local time]: Buyer available to approve B's scoped grant/takeover. Keep wallet connected to [verified network]. I am validating B's recovered state meanwhile.” Present exact transactions when ready; never request blank signatures. These heads-ups happen in active development sessions and requests.md; this plan does not itself run an unattended notification service.

## 11. Release gates, repairs and final handover

If an external smoke test fails at H04, the affected owner diagnoses it immediately while the other continues fixtures, interfaces and local features. Do not spend the day building an integration on an unproven provider. Give the user the specific missing account/action/endpoint with a needed-by time and the next unaffected task.

At H12 retain a known-good core tag. At H16 every feature family must have a runnable mode; absence is a tracked release blocker. At H20 freeze new features and fix defects only. Cut animation, layout polish, generalized configuration and extra model integrations before cutting required behavior. CLI controls are acceptable if documented and human-testable. A simulated test remains labelled simulated; the final main flow requires all three live integrations.

Before final delivery both developers complete:

- [ ] Fresh main job from README on two hosts; exact tagged commit; live ENS/Arkiv/Hedera in one run.
- [ ] Buyer funds rewards and distinct service budget; A/B receive real 3/7 withdrawals.
- [ ] Stale offers/spending rejected; payment-crash produces no duplicate debit; UNKNOWN/restart behavior holds.
- [ ] Tool rejection/fresh access, compatible alternative approach, quantitative import and artifact/cold/mirror modes are runnable.
- [ ] Small DAG, capability ranking, per-task authority and uneven pricing are demonstrated.
- [ ] Pause/cutoff/refund, authority/signature/head races and accounting checks pass.
- [ ] Public deployment manifest and env examples match the code; no secrets in repo/logs/checkpoints.
- [ ] README refreshed, features linked to evidence, human checks recorded, unresolved failures listed explicitly.
- [ ] Demo can reset to a fresh job without wiping settled history; short video and backup receipts available.

The README should let a human answer in under a minute: what works, how to run it, which wallet action is next, what is blocked, and when the next usable feature arrives. Final deliverable is the working model and evidence, with this plan retained as its acceptance checklist.

## Official implementation references

Recheck exact deployments, ABIs, SDKs and supported schemes during H00–H04; documentation is not a live deployment test.

- [ENS documentation and deployment navigation](https://docs.ens.domains/)
- [Arkiv entity creation](https://docs.arkiv.network/writing/create/), [limits](https://docs.arkiv.network/reference/limits/) and [expiration](https://docs.arkiv.network/writing/expiration/)
- [Hedera x402 starter](https://github.com/hedera-dev/x402-hedera) and [payment overview](https://hedera.com/blog/hedera-and-the-x402-payment-standard/)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
