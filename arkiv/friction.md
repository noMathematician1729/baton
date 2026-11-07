# Arkiv feedback

## What we can report now

We do not have a confirmed Arkiv product failure to report. An earlier BATON gate was blocked before a network write because a buyer-owned RPC URL and signer were not configured. A later two-worker core run recorded live Arkiv write and recovery; see [`live-proof.md`](live-proof.md). The remaining gaps are buyer ownership policy, an indexed query, and a user-visible read, not a reproduced Arkiv platform bug.

## Product feedback to validate during the live integration

BATON needs to discover encrypted checkpoint entities by indexed job/task metadata, then retrieve the exact entity selected by the escrow's accepted checkpoint head. A concise end-to-end guide with a runnable SDK filter query, the returned owner/expiry fields, and a testnet readback example would reduce guesswork for this integration. We have not yet verified that the current Arkiv docs omit this information; treat this as a request to improve the builder path, not a defect report.

## Reproduction record

- **Expected:** with a valid Rabdi testnet RPC, access key, and buyer-controlled funded signer, BATON writes an encrypted `baton.content.v2` entity, retrieves it, and verifies its digest and returned owner/expiry.
- **Observed:** the earlier gate found the RPC URL and signer absent. A later core run wrote and read Arkiv entities successfully; no Arkiv SDK failure was recorded.
- **Reproduction of Arkiv failure:** none available. No platform failure is claimed.
- **Next step:** TODO — after a live attempt, record date/time, SDK version, exact sanitized request/query, expected result, actual response/error, entity key or transaction hash, and a minimal reproduction. Never include keys or credentials.

See [`docs/gates.md`](../docs/gates.md) for the current local/live boundary and [Arkiv feedback expectations](https://ethglobal.com/events/mumbai/prizes).
