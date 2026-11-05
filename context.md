# BATON context

Updated 5 November 2026. User decision: Arkiv + ENS + Hedera are required for BATON. The design policies below are proposed architecture defaults, not verified implementation. This context supersedes conflicting scope statements in the older linked architecture.

Storage update: all encrypted checkpoint and task-artifact content is stored in Arkiv, including large inputs and paid outputs. No separate artifact store or independent mirror is planned. The payment-ledger backend (Arkiv vs PostgreSQL) is deferred. Arkiv entity ownership and renewal authority remain to be finalized before live storage writes.

## Product

BATON lets a buyer fund a resumable job, replace a failed worker, and continue from the last accepted checkpoint. Each worker can withdraw the fixed milestone credits they earned. The old worker loses authority to advance the job after takeover.

**Demo.** Fund a three-batch data job with 10 test tokens as worker rewards, plus a separate capped service budget on Hedera. Each batch needs a paid data or compute endpoint accessed through Hedera x402. A buys batch 1; B recovers the reusable output and receipt, reconciles any uncertain purchase, and buys only remaining services. Worker A completes and gets credited 3 for batch 1, then goes offline. Worker B reads the accepted checkpoint from Arkiv on a different host and completes batches 2 and 3 for 7. Submit A's stale offer after the handoff and show its rejection, then show both withdrawals.

## MVP and sources of truth

| Component | Responsibility |
|---|---|
| Sepolia escrow | Holds the funds and records the job, active worker, epoch, accepted checkpoint, credits, and refund. |
| ENSv2 on Sepolia | Provides the buyer-owned job name and a live, scoped worker permission. Use a dedicated resolver for the job. |
| Arkiv Rabdi | Stores encrypted checkpoint manifests, all task artifacts as linked chunks, and discovery metadata. B reads the exact committed manifest and chunks here. |
| Hedera x402 (required) | Settles paid data/compute requests needed by the job; separate from Sepolia worker rewards. BATON must add budget enforcement, receipts and recovery. |
| Buyer-controlled key access | Lets the buyer authorize B to decrypt Arkiv content. Decryption keys remain outside public storage. |
| Worker CLI and buyer console | Run one deterministic workflow, verify results, and show the handoff and payout receipts. |

Use Solidity, Foundry, and OpenZeppelin for the escrow. Use TypeScript, viem, and the Arkiv SDK for the worker and buyer interfaces. Use one buyer wallet, two distinct worker wallets, and one exact-transfer, non-rebasing test ERC-20 for Sepolia rewards. Provision separate Hedera service payment infrastructure; never transfer worker private keys during handoff. The buyer approves milestones and takeover.

## Canonical checkpoint and handoff

1. **Stage.** The active worker encrypts the result and next-step state, writes the manifest and artifact chunks to Arkiv, and signs a milestone offer. The buyer verifies the result, reads back all required ciphertext, checks digests, and verifies retention coverage.
2. **Accept.** One buyer transaction verifies the live ENS grant, worker assignment, epoch, next milestone, expected head, and signed offer. It advances the canonical checkpoint and credits the producing worker atomically.
3. **Recover.** B reads the escrow head at the configured confirmation level. It fetches the exact Arkiv manifest and referenced chunks and verifies their digests and authenticated decryption. The buyer supplies decryption access. B checks the manifest, required artifact availability, capabilities, tool access, licenses and remaining service budget, then reconciles external operations against the durable service ledger. If recovery or required access cannot be verified, B stops.
4. **Take over.** B signs an acknowledgement bound to the exact head and epoch. The buyer submits it with B's live grant in place. The escrow advances the epoch and assigns B without changing the head or existing credits. If A's acceptance changes the head first, B must fetch the new head and sign again.

**Canonical** means the latest checkpoint accepted by the escrow. An Arkiv upload that never gets accepted leaves the previous head in effect. B resumes from that head and may need to redo later work.

## Contract guardrails

- Contract operations include `fundJob`, `acceptMilestone`, `takeover`, `pause`, `resume`, `close`, and `claim`. Follow the detailed architecture for their caller and deadline rules.
- Use EIP-712 offers and acknowledgements. Bind signatures to their action, chain, contract, job, epoch, exact checkpoint, relevant participants, and expiry. The contract also checks the live ENS binding and assigned worker where required.
- Each milestone earns its own pre-agreed fixed amount; amounts may differ. The 3/7 split is an example, not a rule equating progress with pay. Funding always equals unallocated funds plus outstanding credits and refunds plus total withdrawn. Credits survive reassignment and closure.
- Pause blocks new milestone acceptance. The buyer may resume before the cutoff. Anyone may close at or after the cutoff or after completion. Closure refunds the unused balance and preserves earned credits.
- Store ciphertext only on public recovery paths. Keep decryption keys and payment credentials off-chain. Missing or expired Arkiv content, Arkiv unavailability, or loss of the usable key prevents recovery; no independent mirror fallback is planned.

## Build order and verification

1. Prove a real Arkiv write/read and a live ENSv2 grant/revoke on the pinned deployment and ABI.
2. Implement and test the escrow, including stale signatures, both acceptance-versus-takeover orders, deadline/refund, and budget conservation.
3. Prove Hedera x402 settlement through a job-required endpoint, capped spending, durable receipt/output recovery, retry reconciliation and rejection of stale-worker spending at the gateway. Test a crash after settlement but before checkpoint acceptance.
4. Run A and B on separate hosts. Disconnect A, recover from Arkiv, complete the job, and show the stale offer rejection and 3/7 split. Make Arkiv content unavailable and show recovery/takeover failing closed. Verify the planned renewal authority can extend every required entity after A goes offline.

The architecture review passed **22 local tests**, including **100,000 randomized state-transition attempts**. It used real AES-GCM with simulated storage. Sepolia and Arkiv RPC probes timed out. Deployed escrow behavior, EIP-712 integration, live ENS and Arkiv, and the two-host demo remain unverified. Hedera x402 and all expanded portability, governance and matchmaking policies below are also unimplemented/unverified; the earlier test count does not cover them.

If ENS is blocked, the reduced demo can use the escrow's worker assignment and Arkiv recovery. Describe it as that reduced version. Keep automated takeover, independent dispute resolution, intermediate unpaid checkpoints and metered compute compensation outside the initial demo. Hedera x402 is now required. Skill-based matchmaking and probabilistic agent adapters are product extensions, not completed capabilities.

## Context, artifacts and recovery boundaries

BATON transfers accepted work and explicit resumable state, not an agent's hidden cognition or an entire live context window. A workload with 1.5M input tokens does not require one equally large checkpoint or one equally large prompt for B. Token counts are not storage byte sizes; measure serialized bytes and pin actual model limits separately.

The encrypted Arkiv checkpoint contains a versioned recovery manifest: objective and constraints; completed work and evidence; decisions and assumptions; unresolved issues; next actions; artifact references and digests; tool/dependency requirements; service purchase references; and schema/adapter versions. Store all task content in Arkiv, with large corpora, transcripts, model artifacts and tool outputs split into encrypted chunk entities. Manifests bind exact entity references, chunk order, lengths and ciphertext digests; large indexes can be split into linked entities. The accepted checkpoint commits their manifest digest. Hashes detect corruption but do not guarantee availability or access.

Use deltas and content deduplication; B retrieves required chunks and verifies them before reconstruction within its own model budget. Compaction can lose information: keep source artifacts in Arkiv and test recovery against task acceptance criteria. Do not claim lossless arbitrary cross-model continuation. Current Arkiv documentation limits combined `bytes` values in one create or patch to 128 KiB and entity lifetimes to 7,884,000 blocks (about 182.5 days) from creation or extension. Measure ciphertext envelopes against the limit; 96 KiB ciphertext chunks are a provisional application target. Monitor and fund renewal of every referenced entity before expiry. Only the owner can extend unless `permissionlessExtension` was enabled at creation; the ownership/renewal policy must survive A's failure and remains to be finalized. Pin deployment-specific limits, cost and SDK versions during live integration. No separate artifact store or independent mirror is planned.

## Tools, MCP, cache and cross-company compatibility

- Record required capabilities and tool schemas/versions, execution environment or image digests where exportable, MCP server references, input/output formats, data classifications, access scopes and license constraints. A tool manifest describes dependencies; it does not grant access.
- B establishes its own authorized connections. Buyer/owners grant fresh scoped access where permitted. Never export Corp X credentials, private tools, sessions or inaccessible corporate data to Corp Y. ENS permission to work on a job is separate from tool/data authorization.
- At admission, test required access and representative tool behavior. Use an approved equivalent adapter with a conformance check, retain an authorized remote service if its owner permits it, or decline/pause the transfer. Corporate policy or missing rights can make a task nonportable.
- Provider prompt/KV caches are disposable runtime optimizations, not portable checkpoints. Budget for rebuilding context and a cold start. Persist reusable tool results separately with provenance, input/tool-version keys, freshness and entitlement metadata; invalidate when relevant dependencies change.
- Record external operations in a buyer-controlled durable ledger, including stable request IDs, intent, settlement status, receipt, output digest and retrieval entitlement. Query/reconcile uncertain operations before retrying. Require provider-supported idempotency or retrieval of paid results; x402 alone does not guarantee exactly-once work or eliminate duplicate billing.

## Hedera service spending and authority

Keep Sepolia escrow for worker reward credits and ENS checks. Hedera x402 pays services needed by the job. The two chains do not provide an atomic transaction or shared budget balance.

Proposed demo enforcement: a buyer-controlled payment gateway holds Hedera payment authority, serializes spend reservations against a durable ledger, checks the job's confirmed active worker/epoch, and enforces approved services, per-request caps and total service budget. A checkpoint copies receipt references; the ledger remains independently recoverable even if A crashes before checkpoint acceptance. B receives fresh scoped gateway access, never A's wallet key.

The payment-ledger backend is deferred between Arkiv and PostgreSQL. The installed PostgreSQL driver is provisional and no database connection is initialized. Either choice must establish atomic reservations, concurrency control, durable intent and outcome reconciliation before paid requests are enabled. Paid output payloads are encrypted into Arkiv and read back before being marked durably available; failure to store an already paid output does not justify paying again.

For takeover, stop admissions, reconcile/drain in-flight requests, commit the new assignment at the configured confirmation level, then admit B. Reject stale A requests. Previously authorized or settled requests cannot be undone by changing the Sepolia epoch; document confirmation/reorg handling. Unrestricted worker wallets cannot enforce revocation or prevent overspending merely through a checkpoint. The gateway is a disclosed trust dependency. Paid output reuse requires provider entitlements that permit B's access.

## Different approaches, veto and acceptance

The buyer defines outcomes, constraints, acceptance evidence, named verifier/approver and deadline rules before funding; the worker agrees before starting. B may use a different method within those constraints. A's opinions become attributed evidence and assumptions, not binding instructions, unless incorporated into agreed requirements.

For the demo, the buyer has checkpoint/takeover approval and operational pause authority. Capability or access failures block a transfer. Workers can decline a job. Neither A nor B can retroactively veto an already accepted checkpoint or confiscate earned credits. The contract enforces signed rules, not subjective truth. Buyer-controlled acceptance is a trust limitation: preserve the existing cutoff/refund behavior and do not promise fair payment for rejected or unaccepted work. Independent arbitration, acceptance deadlines with automatic remedies, or multi-party review need a separately specified mechanism.

## Probabilistic work and skill-based delegation

BATON can support such workflows if agents expose an explicit state export/import contract. No specific Jev integration has been inspected or verified. Preserve model/code versions, input snapshots and timestamps, units, assumptions, distributions/posteriors or sufficient statistics, uncertainty, evaluation criteria and random seeds where meaningful. Seeds alone do not ensure reproducibility across runtimes. Proprietary models or nonexportable latent state can prevent continuation; B may consume signed outputs instead only if the task permits that boundary.

Approve probabilistic work by agreed process/evidence checks and suitable evaluation across resolved cases, such as calibration or proper scoring rules for forecasts. A single realized outcome cannot establish whether a probability estimate was sound. Financial or other consequential actions retain the buyer's explicit risk/authorization constraints.

A larger job can be a dependency graph of subtasks, each with required capabilities, data/tool rights, risk/budget limits, acceptance rules, checkpoint and credits. Match hard eligibility first, then rank qualified candidates using relevant verified evidence; self-declared skills or confidence are insufficient. Distinguish planned delegation from failure recovery. Multiple active subtasks require per-task authority/epochs and accounting; the current single-active-worker contract does not implement this.

## Milestone pricing

Progress percentage and reward percentage are independent. Before funding, buyer and worker agree each milestone's deliverable, acceptance rule, fixed reward, verifier and service-spend allowance. For example, a milestone representing roughly 30% of processing can earn 10% of rewards, with later verification/delivery earning 90%, if explicitly agreed. Accepted rewards are immutable credits to their producing worker, not reassigned to B. Renegotiation requires authorized agreement and contract support, cannot rewrite earned credits, and must conserve funds. Service purchases, worker rewards and model confidence are separate quantities.

## Documentation checked 5 November 2026

- Arkiv limits: https://docs.arkiv.network/reference/limits/
- Arkiv expiration and renewal: https://docs.arkiv.network/writing/expiration/
- Anthropic cache isolation: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- MCP authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- Hedera x402: https://hedera.com/blog/hedera-and-the-x402-payment-standard/

[Full BATON product and architecture](https://chatgpt.com/library?file_id=libfile_4da5858b005c8191b23e9be395e3c7a7&account_id=personal)
