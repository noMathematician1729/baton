# BATON Arkiv schema

This describes the checked-in adapter. A later core run recorded a live Arkiv write and worker recovery; see [`live-proof.md`](live-proof.md). The schema is declared in [`server/packages/storage/src/arkiv.ts`](../server/packages/storage/src/arkiv.ts).

## Network

- **Network:** Arkiv Rabdi testnet
- **Chain ID:** `7794095`
- **RPC:** `https://rpc.rabdi.db-chain.testnet.arkiv.network`
- **Explorer:** `https://rabdi.explorer.arkiv.network`
- **Indexer:** `https://indexer.rabdi.db-chain.testnet.arkiv.network`
- **Recorded manifest entity / transaction:** `0x08701dfe4f2da7be5ef233d64ea921c6d818c71e19af88103c0d4f53bc4705f8` / `0x67350aa54efe1d8162e8042a8f443729944d41450628bba48990a704bf6b1d0c`

See the [official ETHGlobal Arkiv track](https://ethglobal.com/events/mumbai/prizes) and [Arkiv creation docs](https://docs.arkiv.network/writing/create/).

## Entity type

The adapter defines one Arkiv schema, `baton.content.v2`, for encrypted checkpoint manifests and encrypted artifact chunks.

| Field | Type | Indexed? | Purpose / visibility |
|---|---|---:|---|
| `jobId` | string | yes | Job grouping and candidate filtering. Public metadata. |
| `taskId` | string | yes | Task grouping and candidate filtering. Public metadata. |
| `kind` | string | yes | `manifest` or `artifact`. Public metadata. |
| `contentId` | string | yes | Manifest digest or artifact identifier. Public metadata. |
| `chunkIndex` | signed 32-bit integer | yes | Chunk ordering and lookup. Public metadata. |
| `payloadDigest` | string | no | SHA-256 digest of the encrypted payload. |
| `payload` | bytes | no | Serialized encrypted manifest envelope or encrypted artifact chunk. Publicly readable ciphertext. |

Arkiv entities are publicly readable. The payload is encrypted by BATON before the SDK write; job/task identifiers, content descriptors, digest, ownership, and expiry are not a privacy boundary. BATON keeps decryption keys and wallet credentials outside the entity.

## Ownership, updates, and expiry

The Arkiv wallet signer in `ArkivContentStore` owns entities it creates. The adapter defaults to **180 days** per entity write, configurable from 1 to 182 days, and asks Arkiv for `permissionlessExtension`. The permissionless flag permits anyone to extend entity expiry; it does not give them the owner's attribute-edit authority. The adapter's `extend()` method checks that its configured signer is the entity owner before it submits an extension. Arkiv's documented entity lifetime is bounded and entities need extension before expiry; BATON makes no permanence claim. See [Arkiv expiration](https://docs.arkiv.network/writing/expiration/).

The app's intended policy is to retain accepted checkpoint content while a job can still be resumed, renew owner-controlled entities as needed, and allow unused records to expire. The buyer escrow, not Arkiv, decides which checkpoint is accepted.

## Query and entity evidence

**Indexed query:** TODO — the current adapter retrieves an entity by exact key using `getEntity`; it has no indexed `.where()` query or judge-runnable query command. Add a testnet query over `jobId`/`taskId`/`kind`, document its exact syntax, and show its result in a user-visible BATON feature before claiming query-driven use.

**Wallet that wrote the checked manifest:** Worker A, `0x432Eeff3E312f1910F3D04A6449753306fFaA5D2`. This entity is worker-owned, not buyer-owned.

**Entity evidence:** see [`live-proof.md`](live-proof.md) and the checked-in core run. A fresh public RPC read on 7 November returned an earlier drill manifest with encrypted payload, owner and expiry. Record a fresh read of the latest manifest and a public explorer link before submission.

## Sources

- [ETHGlobal Mumbai prize page](https://ethglobal.com/events/mumbai/prizes)
- [Arkiv introduction](https://docs.arkiv.network/start-here/introduction/)
- [Arkiv entity creation](https://docs.arkiv.network/writing/create/)
- [Arkiv expiration](https://docs.arkiv.network/writing/expiration/)
- [Arkiv query filters](https://docs.arkiv.network/querying/filter/)
