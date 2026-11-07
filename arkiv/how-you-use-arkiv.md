# How BATON uses Arkiv

## Current data flow in code

1. BATON builds a checkpoint manifest or artifact chunk and encrypts it before storage.
2. `ArkivContentStore.writeEncrypted()` writes it as a `baton.content.v2` entity to the Rabdi testnet using `@arkiv-network/sdk`.
3. A returned entity key, digest, owner, and expiry are added to BATON's checkpoint references. A separate escrow acceptance selects the canonical checkpoint head; an unaccepted upload does not become canonical merely because Arkiv stored it.
4. Recovery retrieves the expected entity by exact key, checks ciphertext digest, decrypts with separately granted key material, and verifies artifact length/digest.
5. The adapter can extend an entity while the configured signer owns it; the write default is 180 days and uses the permissionless-extension flag.

Source: [`server/packages/storage/src/arkiv.ts`](../server/packages/storage/src/arkiv.ts), [`server/packages/checkpoint/src/schema.ts`](../server/packages/checkpoint/src/schema.ts), and [`docs/gates.md`](../docs/gates.md).

## Fields, edit rights, and expiry

The indexed fields (`jobId`, `taskId`, `kind`, `contentId`, and `chunkIndex`) are intended to select a job's manifests and artifact chunks. The adapter currently reads by exact entity key and has no indexed-filter query, so this selection flow is not yet implemented. The checked live manifest is owned by worker A. Owner edit/extension authority follows Arkiv; BATON checks ownership before its own renewal call. The `permissionlessExtension` flag allows third parties to extend expiry without allowing them to edit attributes, and a recorded retention check shows worker B doing so. A 180-day default is meant to cover active work and can be renewed before expiry; abandoned content can expire.

## What changes for the user today

The adapter and local tests cover encryption, exact-key retrieval, digest verification, and artifact reconstruction. A later two-worker core run recorded a live Arkiv write and B's recovery from A's checkpoint; see [`live-proof.md`](live-proof.md). The public frontend still does not demonstrate a user-visible Arkiv read.

To meet the track, connect the indexed query and exact accepted-head read to a visible recovery view. Publish reproducible current entity reads, owner/expiry evidence, and the user-visible continuation.

## What to measure for the final demo

- A reproducible indexed query, exact command, matching entity key(s), and expected owner.
- A real transaction and subsequent readback for the encrypted manifest and at least one artifact.
- A visible successor-worker recovery that uses the Arkiv data rather than a local fixture.
- The observed expiry, owner, and renewal behavior, with the entity key and transaction links.
- Any actual Arkiv friction, including a sanitized minimal reproduction.

See [`live-proof.md`](live-proof.md), [`friction.md`](friction.md), and [`schema.md`](schema.md) for the evidence and remaining gaps.

## Sources

- [ETHGlobal Mumbai prize page — How you use Arkiv criterion](https://ethglobal.com/events/mumbai/prizes)
- [Arkiv entity creation](https://docs.arkiv.network/writing/create/)
- [Arkiv query filters](https://docs.arkiv.network/querying/filter/)
- [Arkiv expiration](https://docs.arkiv.network/writing/expiration/)
