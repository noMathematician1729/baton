# BATON input queue

Times are Asia/Kolkata. Secrets must be entered into the local `.env`/keystore, never this file or chat.

| ID | Requester | Responsible person | Item/action | Requested at | Needed by | Gate | State |
|---|---|---|---|---|---|---|---|
| R-D1-01 | D1 | Buyer/operator | Provide public Sepolia escrow and explicit job-authority resolver addresses for read-only verification | 2026-11-05 22:32 | Before live authority gate | G2/G4 | REQUESTED |
| R-D1-02 | D1 | Buyer/operator | Confirm RPC connectivity and public buyer/A/B addresses; keep private keys local | 2026-11-05 22:32 | Before live signing gate | G4/G5 | REQUESTED |
| R-D1-03 | D1 | Build environment | Make solc 0.8.28 available locally or enable the Foundry compiler download | 2026-11-05 22:32 | Before contract deployment | G3/G4 | BLOCKED |
| R-D2-01 | D2 | D1 | Publish protocol head/checkpoint types and typed signing fixture | 2026-11-05 22:21 | 2026-11-05 22:47 | G0 | READY |
| R-D2-02 | D2 | B operator + D2 | Confirm B host availability and its separate worker directory | 2026-11-05 22:21 | 2026-11-05 23:17 | G1 | REQUESTED |
| R-D2-03 | D2 | D2 | Complete the local checkpoint key and remaining Sepolia config in ignored `.env`; do not paste secrets in chat | 2026-11-05 22:21 | Before live storage/authority gate | G2/G4 | REQUESTED |

## Current decisions

- All encrypted checkpoint and task-artifact content goes to Arkiv. No independent mirror or alternate artifact store.
- SQLite is selected for buyer-host payment-operation metadata. `PAYMENT_LEDGER_PATH` configures the local database file; it is separate from Arkiv payload storage.
- Arkiv entity ownership and renewal authority must be finalized before content writes are enabled.
- The last redacted environment check passed Arkiv Rabdi RPC and Hedera account reads. It found `CHECKPOINT_ENCRYPTION_KEY`, Sepolia RPC, escrow address and ENS resolver missing/invalid. No Arkiv content write or paid x402 request was made.
- The D1 protocol/signing files are now available on `build/authority-payments`; integration is in progress.
