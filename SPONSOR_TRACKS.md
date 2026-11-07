# ETHGlobal Mumbai sponsor tracks

Prepared 7 November 2026 for the BATON checkout in this repository. This dossier covers the two selected tracks:

1. **Build on Arkiv (from scratch) — $4,000** ($3,000 first place; $1,000 second place).
2. **Best Use of ENSv2 — $7,000** ($3,000 first, $2,000 second, $1,000 each for third and fourth).

Track rules below reflect the [official ETHGlobal Mumbai prize page](https://ethglobal.com/events/mumbai/prizes), checked on 7 November 2026. ETHGlobal's [general rules](https://ethglobal.com/rules) also govern project eligibility and disclosure. This is a documentation and readiness record, not an entry or a claim that the live integrations have passed.

## Readiness at a glance

| Requirement | Arkiv from scratch | ENSv2 Best Use | BATON evidence now |
|---|---|---|---|
| Network qualification | Arkiv's current testnet | Ethereum mainnet **or Sepolia** | A later core run recorded live Rabdi write and B recovery; the ENS authority path is Sepolia-specific. |
| Core integration | New app built at Mumbai; app writes to Arkiv and a user-visible feature reads from Arkiv | ENSv2 is central; functional demo must use live values, not hard-coded values | Arkiv recovery is recorded in a core run, but no user-visible Arkiv read is evidenced. ENS code checks a job-scoped EAC grant; the console's name tree is simulation. |
| Required submission docs | README wallet address(es) and runnable query; five `/arkiv/*.md` files; public source with open-source license; AI-use disclosure | Showcase links a live demo and public open-source source. No ENS-specific filename is prescribed. | A live writer wallet is recorded. A judge-runnable indexed query, visible recovery demo, and root license remain missing. |
| Eligibility risk | “From scratch” must satisfy kickoff rule; existing work requires approved Continuity status to enter partner prizes | General ETHGlobal pre-existing-work rule also applies | Visible Git history begins 5 November 2026 at 21:16 IST. Official kickoff time and BATON's team track status have not been confirmed, so eligibility is unknown. |

**Current status:** neither entry has a complete proof package. The Arkiv core run and Sepolia ENS grant/lifecycle have live evidence, while the indexed Arkiv query and user-visible read remain open. See [`arkiv/live-proof.md`](arkiv/live-proof.md). Confirm eligibility before selecting the Arkiv category.

## Arkiv: Build on Arkiv (from scratch) — $4,000

### Official qualification requirements

The [ETHGlobal prize page](https://ethglobal.com/events/mumbai/prizes) requires an app built from scratch at ETHGlobal Mumbai that writes to Arkiv's current testnet using `@arkiv-network/sdk` or its JSON-RPC API, with at least one user-visible feature that reads data from Arkiv. Merely installing the SDK or writing unread logs does not qualify. The README must list the wallet address(es) that wrote the entities and provide one query judges can run. The public repository must have an open-source license and disclose AI use.

The page gives equal weight (25% each) to four judging dimensions and requires one file per dimension, alongside the schema document:

| Criterion | Weight | Required path | Judges ask |
|---|---:|---|---|
| Arkiv feedback | 25% | [`arkiv/friction.md`](arkiv/friction.md) | What should improve? What broke, what was expected, what happened, and how can it be reproduced? |
| Reach | 25% | [`arkiv/reach.md`](arkiv/reach.md) | Who is it for, can they try it, and will the team continue after Mumbai? |
| Why Arkiv | 25% | [`arkiv/why-arkiv.md`](arkiv/why-arkiv.md) | What would users lose if the app used Postgres or another database? What stays off Arkiv and why? |
| How Arkiv is used | 25% | [`arkiv/how-you-use-arkiv.md`](arkiv/how-you-use-arkiv.md) | Do indexed filters, edit authority and expiry fit the app, and does each feature change the user experience? |
| Schema | Qualification document | [`arkiv/schema.md`](arkiv/schema.md) | Entity types, queried fields, owners and expiry behavior. |

The separate **Build on Arkiv (existing projects)** award is also $4,000 but is restricted to ETHGlobal Continuity participants; only Arkiv work added at Mumbai is judged. The current target is the from-scratch category, so Continuity is a fallback only if BATON's team was officially placed in that batch and the submission follows those rules.

### BATON mapping and evidence boundary

`server/packages/storage/src/arkiv.ts` defines `baton.content.v2` with indexed `jobId`, `taskId`, `kind`, `contentId` and `chunkIndex` fields. It encrypts manifests and artifact chunks before writing with the Arkiv SDK, defaults to a 180-day expiry, allows permissionless expiry extension, reads entities by exact key, checks ciphertext digests, and validates recovered content. The owner and expiry are returned as metadata. `server/packages/storage/src/arkiv.test.ts` uses an in-memory harness. The earlier gate at [`docs/gates.md`](docs/gates.md) predates the later live core run documented in [`arkiv/live-proof.md`](arkiv/live-proof.md).

The current adapter does **not** perform an indexed SQL-like filter query. The later core run records recovery from known Arkiv entity references, but this is not evidence that a user-visible feature currently queries Arkiv data. The local demo is a fixture. The current evidence remains short of Arkiv prize qualification.

### Submission blockers and next evidence

1. Confirm BATON was created after the official kickoff or that the team has approved Continuity status. The available commit history alone does not establish that rule.
2. Reproduce the live Arkiv checkpoint read with current owner, expiry and explorer evidence; establish buyer-controlled ownership or document the worker-owned retention policy. Never publish credentials.
3. Implement and run an indexed query over the entity schema, then surface its result in a user-visible feature. Record the exact judge-runnable query in the README.
4. Demonstrate the full visible read path in a live demo; add the URL and reproducible steps.
5. Replace the explicit TODOs in the Arkiv judging files with event-observed friction, real audience/testing facts, and measurements. Do not claim a network failure unless it was actually reproduced.
6. Add a team-approved open-source `LICENSE` file and complete the AI disclosure.

## ENS: Best Use of ENSv2 — $7,000

### Official qualification requirements

The [ETHGlobal prize page](https://ethglobal.com/events/mumbai/prizes) calls for meaningful use of ENSv2's hierarchical registries, wildcard resolution, Enhanced Access Control, Permissioned Resolvers, or record/namespace aliasing. The explicit qualification allows **Ethereum mainnet or Sepolia**. ENSv2 must be central to the app; the demo must be functional and not based on hard-coded values; the project showcase must link to a live demo; and the code must be public and open source. The page does not prescribe ENS-specific Markdown paths or publish a weighted scoring rubric.

### BATON mapping and evidence boundary

The current implementation centers on **EAC through an ENSv2 Permissioned Resolver**. `server/contracts/src/JobAuthority.sol` checks `ROLE_SET_DATA` for a resource derived from the job-specific `baton.job.v1:<job-id>` key. The Sepolia authority reader checks the worker assignment and grant as part of admission. [`docs/gates.md`](docs/gates.md) records a D1-reported live Sepolia sequence: grant → authorized, wrong job → unauthorized, revoke → unauthorized. That record is a useful testnet result, but it does not include detailed transaction receipts for the authority checks in the checked-in evidence directory.

The checked-in frontend's ENS tree is seeded simulation, and the current repository has no job/worker subname provisioning or live record-resolution lifecycle. Do not describe BATON as minting or rotating ENS subnames, publishing active-worker records, or resolving checkpoint pointers unless that behavior is newly implemented and demonstrated. The escrow, actual ENS resolver, and `JobAuthority` adapter are distinct addresses and must be labeled separately.

### Recommended proof flow

Use a live Sepolia-backed operation so that ENS authority visibly changes BATON behavior: demonstrate the intended worker with the job-scoped grant, show a different job remains unauthorized, revoke the grant, and show that worker no longer passes authorization. The current script [`scripts/test-ens-authority-sepolia.mjs`](scripts/test-ens-authority-sepolia.mjs) exercises the authority boundary; the entry demo still needs a live app URL and a visible, non-seeded result. Record the ENS name (if used), resolver address, adapter address, escrow address, chain, explorer links, transaction hashes, and exact steps in [`ENSV2_TRACK.md`](ENSV2_TRACK.md).

## Shared event rules and final checklist

ETHGlobal's [general event rules](https://ethglobal.com/rules) require disclosure of pre-existing project-specific work; Classic from-scratch entries must respect the official kickoff, and pre-kickoff work affects partner-prize eligibility unless the submission is accepted under Continuity. This checkout's visible Git history starts on 5 November 2026 at 21:16 IST; the official kickoff timestamp and the team's track assignment were not available in the reviewed material. That commit timestamp cannot settle eligibility. Confirm both against the event record, then include a dated baseline and the actual Mumbai changes in the project submission and demo description.

- [ ] Confirm event track status, kickoff timestamp, and whether this BATON submission is eligible for from-scratch or Continuity.
- [ ] Publish the repo with a license the team has chosen; the current checkout has no root `LICENSE` file.
- [ ] Add a public, functional demo URL and ensure the submission showcase links to it.
- [ ] Disclose all relevant prior work and all AI tools/models used; see the current, deliberately narrow disclosure in [`README.md`](README.md).
- [ ] For Arkiv: produce a real write, indexed query, user-visible read, writer wallet, entity/expiry evidence, and five complete Arkiv judging files.
- [ ] For ENSv2: demonstrate a real non-hard-coded EAC permission change on Sepolia or mainnet and capture the resulting BATON behavior, addresses and receipts.
- [ ] Keep testnet/local fixtures, reported historical checks, and current live evidence clearly distinct in the demo and submission.

## Primary sources

- [ETHGlobal Mumbai prizes](https://ethglobal.com/events/mumbai/prizes)
- [ETHGlobal event rules](https://ethglobal.com/rules)
- [Arkiv introduction](https://docs.arkiv.network/start-here/introduction/)
- [Arkiv entity creation](https://docs.arkiv.network/writing/create/)
- [Arkiv expiration](https://docs.arkiv.network/writing/expiration/)
- [Arkiv query filters](https://docs.arkiv.network/querying/filter/)
- [ENSv2 Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/)
- [ENSv2 Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/)
- [ENSv2 subnames](https://docs.ens.domains/ensv2/subnames/)
