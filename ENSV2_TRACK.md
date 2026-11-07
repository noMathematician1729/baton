# ENSv2 Best Use track dossier

**Target:** ETHGlobal Mumbai 2026 · Best Use of ENSv2 · $7,000.

**Entry network:** Sepolia. The posted qualification accepts Ethereum mainnet or Sepolia; mainnet migration is not required for this track. ENSv2 must be central to BATON, and the demo must be functional, use live values rather than hard-coded values, and appear as a live URL in the project showcase. The code must be public and open source. See the [official prize page](https://ethglobal.com/events/mumbai/prizes).

## BATON's ENSv2 use

The current implementation uses ENSv2's **Enhanced Access Control (EAC)** through a **Permissioned Resolver** as a job-scoped worker authority check. BATON's `JobAuthority` contract reads `roles(resource, worker)` for `ROLE_SET_DATA` on a resource derived from the `baton.job.v1:<job-id>` key. The Sepolia authority reader uses that result in worker admission. This makes ENSv2 affect whether a worker can act; it is more than an ENS name shown as a label.

Current code references:

- [`server/contracts/src/JobAuthority.sol`](server/contracts/src/JobAuthority.sol) — resolver role interface, job-key/resource derivation, and scoped grant check.
- [`server/src/chain/sepoliaAuthority.ts`](server/src/chain/sepoliaAuthority.ts) — Sepolia reader and worker authority checks.
- [`scripts/test-ens-authority-sepolia.mjs`](scripts/test-ens-authority-sepolia.mjs) — live Sepolia grant, wrong-job and revoke assertions.
- [`docs/gates.md`](docs/gates.md) — dated test evidence and limits.
- [`server/contracts/README.md`](server/contracts/README.md) — resolver, adapter and escrow address separation.

## What the current evidence proves

The project gate record marks grant → authorized, wrong job → unauthorized, and revoke → unauthorized as live Sepolia checks. A fresh V2 lifecycle on 7 November recorded 17 successful receipts, including ENS grants and revocations, takeover, and worker claims in [`evidence/sepolia-jobs/34121682400bc030cfdae1e1804fbe354d48ec53d46a1ce5873959db5eb6ee13.json`](evidence/sepolia-jobs/34121682400bc030cfdae1e1804fbe354d48ec53d46a1ce5873959db5eb6ee13.json). The resolver and `JobAuthority` adapter are distinct addresses.

This evidence does **not** establish a complete track demo. The receipt bundle covers ENS grant/revoke transactions, but no ENSv2 job/worker subname provisioning, parent/child registry flow, dynamic ENS records, or live resolution UI is proven. The animated ENS tree in the console is seeded simulation.

## Demo proof to capture

Make the authority result visible in a live BATON flow on Sepolia. The recommended sequence follows the current EAC implementation:

1. Show the app connected to Sepolia and identify the job, ENS Permissioned Resolver, `JobAuthority` adapter, and escrow separately.
2. Show that the assigned worker's scoped `ROLE_SET_DATA` grant for this job allows the authorized action.
3. Attempt an action for a different job/resource and show it is denied.
4. Revoke the scoped grant and show the same worker is denied afterward.
5. Include transaction links, current chain reads, and code paths used. Ensure the result is fetched from ENSv2/chain state during the demo and is not seeded into the UI.

The existing authority script is a useful technical check but is not yet a published live demo. If the team adds a subname lifecycle before submission, document which ENSv2 model is used: shared resolver records or owned child names in a child registry. Show the live create/update/revoke/resolve path before claiming a name hierarchy feature.

## Submission details to fill from the final run

- **Live demo URL:** TODO — publish and add to the ETHGlobal project showcase.
- **Public source URL:** `https://github.com/ashwera/baton` is configured as `origin`; verify public access and add it to the showcase.
- **Network and chain ID:** Sepolia · `11155111` (confirm the deployed run).
- **ENS name:** TODO — add the actual name used, or write “none; authority is exercised on the configured Permissioned Resolver” if no name is part of the demo.
- **ENS resolver proxy:** [`0x583fDD4b8d345624B1B8438Bd8ca5004bD0352bA`](https://sepolia.etherscan.io/address/0x583fDD4b8d345624B1B8438Bd8ca5004bD0352bA).
- **BATON `JobAuthority` adapter:** [`0xD659F372D2439075F29e39f5E005d86352Da1A6c`](https://sepolia.etherscan.io/address/0xD659F372D2439075F29e39f5E005d86352Da1A6c).
- **BATON V2 escrow:** [`0x33dFd9b59a5CA4c246a85dDDda033c9c400C7f8e`](https://sepolia.etherscan.io/address/0x33dFd9b59a5CA4c246a85dDDda033c9c400C7f8e).
- **Grant / denial / revoke transactions:** see the new V2 lifecycle evidence file above. Wrong-job denial and stale-worker rejection are read/simulation assertions, not successful transactions.
- **Pre-existing work disclosure:** TODO — link the dated baseline, ETHGlobal track status, and Mumbai changes.
- **Open-source license:** TODO — add a team-approved root `LICENSE` before submission; none is present in this checkout.
- **AI disclosure:** see [`README.md`](README.md); expand it to include all AI assistance used for the build and assets.

## Track sources

- [ETHGlobal Mumbai prizes — ENS Best Use of ENSv2](https://ethglobal.com/events/mumbai/prizes)
- [ENSv2 Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/)
- [ENSv2 Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/)
- [ENSv2 subnames](https://docs.ens.domains/ensv2/subnames/)
- [ETHGlobal rules](https://ethglobal.com/rules)
