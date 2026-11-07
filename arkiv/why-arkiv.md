# Why BATON uses Arkiv

## What users gain

BATON's recovery problem involves work products that need to cross worker boundaries. Arkiv holds wallet-owned, queryable entities with explicit expiry; a replacement can retrieve a checkpoint package after the original worker stops, while BATON's escrow selects the accepted head. A conventional Postgres replacement could still provide reliable storage, but BATON would lose the Arkiv-specific public entity/query interface, wallet ownership semantics, and chain-native bounded lifetime that let independent parties inspect and retrieve shared job state. A two-worker core run recorded live Arkiv-backed recovery; see [`live-proof.md`](live-proof.md).

The application must make this difference visible. The current adapter does exact-key reads and has not demonstrated an indexed query or a user-facing Arkiv read. Until those are added and exercised on Rabdi, the data layer is an implementation direction rather than a user benefit established by the demo.

## What BATON keeps off Arkiv

Arkiv entities are publicly readable, so BATON encrypts the checkpoint manifest and artifact bytes before writing them. The AES-GCM key, wallet private keys, provider credentials, and other secrets stay off Arkiv. The schema's indexed job/task identifiers, content type, content ID, and chunk index are public metadata and can reveal relationships; encryption of `payload` does not hide those fields. Do not place plaintext private data or decryption keys in an entity.

The escrow keeps the canonical accepted checkpoint head and reward state. Arkiv stores the content entity; it does not validate buyer acceptance, authorize successor access, enforce payments, guarantee permanent availability, or decide which upload is canonical.

## Evidence and limits

The adapter encrypts payloads, writes typed entities, reads by exact key, checks digest integrity and records owner/expiry metadata. Its default expiry is a BATON setting (180 days), not an Arkiv default. Local storage tests use memory; the later core run provides live write/readback evidence. The checked manifest is worker-owned, and a separate retention check records B extending an A-owned entity through permissionless extension.

Before submission, show a user-visible checkpoint read from Arkiv, demonstrate the indexed query, and replace the current intended-benefit description with what a user actually sees. Do not describe the data as private, permanent, immutable, or independently mirrored.

## Sources

- [ETHGlobal Mumbai prize page — Why Arkiv criterion](https://ethglobal.com/events/mumbai/prizes)
- [Arkiv introduction](https://docs.arkiv.network/start-here/introduction/)
- [Arkiv query filters](https://docs.arkiv.network/querying/filter/)
- [Arkiv expiration](https://docs.arkiv.network/writing/expiration/)
- [`ArkivContentStore`](../server/packages/storage/src/arkiv.ts)
