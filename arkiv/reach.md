# BATON's reach

## Who it is for

BATON is for teams running long agent jobs where a worker can stop before the job is done. Buyers need a successor worker to retrieve the buyer-accepted work product, verify it, and continue without treating an unaccepted upload as canonical. Agent developers and operators are the intended users; this is a product target, not a measured user base.

## Can people try it today?

The local console and fixture flows can be run from this repository using the Quick start instructions in [`README.md`](../README.md). The documented local demo uses synthetic batches. A later two-worker core run recorded live Arkiv checkpoint write and B recovery; see [`live-proof.md`](live-proof.md). The public frontend still lacks a user-visible Arkiv recovery feature, so the Arkiv track demo is not yet complete.

- **Live Arkiv demo URL:** TODO — publish after a user-visible testnet read path works.
- **Runnable query and entity evidence:** TODO — see [`schema.md`](schema.md).
- **Users or trial results:** TODO — add only actual user interviews, trials, or usage collected by the team.

## Continuation after Mumbai

The codebase already contains a checkpoint storage adapter, recovery verifier, and retention handling. Those are implementation components, not evidence of user demand or a commitment to ship beyond the event. **Team continuation plan:** TODO — state whether the team will continue this work after Mumbai, who owns it, and the next concrete milestone.

The next useful milestone is a buyer-owned write/read/query path and a visible recovery view, then operator feedback on whether to make Arkiv-backed recovery a supported BATON workflow.

## Track sources

- [ETHGlobal Mumbai prize page — Reach criterion](https://ethglobal.com/events/mumbai/prizes)
- [BATON gate evidence](../docs/gates.md)
