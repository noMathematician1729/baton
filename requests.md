# BATON input queue

Times are Asia/Kolkata. Secrets must be entered into the local `.env`/keystore, never this file or chat.

| ID | Requester | Responsible person | Item/action | Requested at | Needed by | Gate | State |
|---|---|---|---|---|---|---|---|
| R-D1-01 | D1 | Buyer/operator | Provide public Sepolia escrow and explicit job-authority resolver addresses for read-only verification | 2026-11-05 22:32 | Before live authority gate | G2/G4 | REQUESTED |
| R-D1-02 | D1 | Buyer/operator | Confirm RPC connectivity and public buyer/A/B addresses; keep private keys local | 2026-11-05 22:32 | Before live signing gate | G4/G5 | REQUESTED |
| R-D1-03 | D1 | Build environment | Make solc 0.8.28 available locally or enable the Foundry compiler download | 2026-11-05 22:32 | Before contract deployment | G3/G4 | BLOCKED |

Local authority/payment work continues without these inputs. No live pass is claimed until the inputs are independently verified.
