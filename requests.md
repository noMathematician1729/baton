# External inputs and coordination

Secrets go into the owning host's ignored .env or keystore. Do not send secret values in chat.

| ID | Requester | Responsible | Item/action | Requested at (Asia/Kolkata) | Needed by (Asia/Kolkata) | Gate | State |
|---|---|---|---|---|---|---|---|
| R-D2-01 | D2 | D1 | Publish protocol head/checkpoint types and typed signing fixture; D2 will keep storage envelope separate | 2026-11-05 22:21 | 2026-11-05 22:47 | G0 | BLOCKED |
| R-D2-02 | D2 | B operator + D2 | Confirm B host is available for isolated cold recovery and has a separate worker directory | 2026-11-05 22:21 | 2026-11-05 23:17 | G1 | REQUESTED |
| R-D2-03 | D2 | D2 | Provide private Arkiv/RPC credentials and signer through local ignored env/keystore; do not paste values into chat | 2026-11-05 22:21 | 2026-11-06 00:17 | G2 | REQUESTED |

## Current decisions

- All checkpoint and artifact payloads go to Arkiv; no application-managed artifact store or independent mirror.
- SQLite is selected for the buyer-host payment-operation ledger; it stores ledger metadata while encrypted checkpoint/artifact/paid-output content stays in Arkiv.
- Arkiv entity ownership and renewal authority remain undecided. Live writes stay disabled until this policy and the live retention path are proven.
- At H00:30, D1 was not ready to publish the shared interface; continue against D2 adapters per user direction. No local D1 branch/status file is present.
- Final redacted `.env` check: Arkiv Rabdi read and Hedera account lookup passed. `CHECKPOINT_ENCRYPTION_KEY`, Sepolia RPC, escrow address and ENS resolver are missing/invalid. `PAYMENT_LEDGER_PATH` may use its server default. No Arkiv write or paid x402 request was made.
