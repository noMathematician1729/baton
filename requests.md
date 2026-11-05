# BATON input queue

Times are Asia/Kolkata. Secrets must be entered into the local `.env`/keystore, never this file or chat.

| ID | Requester | Responsible person | Item/action | Requested at | Needed by | Gate | State |
|---|---|---|---|---|---|---|---|
| R-D1-01 | D1 | Buyer/operator | Provide or deploy a BATON-compatible job-permission adapter on Sepolia; it must expose `isAuthorized(bytes32,address)` and reflect the intended ENSv2 grant | 2026-11-05 22:32 | Before live authority gate | G2/G4 | REQUESTED |
| R-D1-02 | D1 | Buyer/operator | Confirm RPC connectivity and public buyer/A/B addresses; keep private keys local | 2026-11-05 22:32 | Before live signing gate | G4/G5 | REQUESTED |
| R-D1-03 | D1 | Build environment | Make solc 0.8.28 available locally or enable the Foundry compiler download | 2026-11-05 22:32 | Before contract deployment | G3/G4 | READY |
| R-D2-01 | D2 | D1 | Publish protocol head/checkpoint types and typed signing fixture | 2026-11-05 22:21 | 2026-11-05 22:47 | G0 | READY |
| R-D2-02 | D2 | B operator + D2 | Confirm B host availability and its separate worker directory | 2026-11-05 22:21 | 2026-11-05 23:17 | G1 | REQUESTED |
| R-D2-03 | D2 | D2 | Complete the local checkpoint key and Sepolia RPC/escrow config in ignored `.env`; do not paste secrets in chat | 2026-11-05 22:21 | Before live storage/authority gate | G2/G4 | READY |
| R-D2-04 | D2 | Buyer/operator | Define Arkiv entity ownership and renewal authority before the first content write | 2026-11-06 01:32 | Before first live Arkiv write | G2 | REQUESTED |

## Current decisions

- All encrypted checkpoint and task-artifact content goes to Arkiv. No independent mirror or alternate artifact store.
- SQLite is selected for buyer-host payment-operation metadata. `PAYMENT_LEDGER_PATH` configures the local database file; it is separate from Arkiv payload storage.
- Arkiv entity ownership and renewal authority must be finalized before content writes are enabled.
- Latest redacted `.env` shape check: Arkiv RPC/access/signer, 64-hex checkpoint key, Sepolia RPC/chain/escrow, ENS job name, worker/deployer keys and Hedera account/key/facilitator are present. The configured ENS address has code and matches the name's Sepolia resolver, but its `isAuthorized(bytes32,address)` probe reverted or was unavailable; it is not the BATON-compatible adapter. Configuration presence is not a live verification.
- No Arkiv content write or paid x402 request has been made. The API still uses the local payment provider fixture.
- The ENSv2 name/resolver lookup passed read-only on Sepolia, but the custom BATON permission interface did not. The repository currently contains the `JobAuthority` wrapper/interface, not the grant adapter implementation.
- D1 protocol, contracts and signing files are integrated on `build/runtime-recovery`; the SQLite ledger and HTTP restart path pass local verification.
- The current dependency audit points to `solc@0.8.28` -> `tmp@0.0.33`: one high path-traversal advisory and one low symlink temp-write advisory. A dry-run proposes `tmp@0.2.6` and `solc@0.8.38`; no dependency changes were applied.
