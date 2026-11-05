# BATON input queue

Times are Asia/Kolkata. Secrets must be entered into the local `.env`/keystore, never this file or chat.

| ID | Requester | Responsible person | Item/action | Requested at | Needed by | Gate | State |
|---|---|---|---|---|---|---|---|
| R-D1-01 | D1 | Buyer/operator | Confirm that the Sepolia `baton.eth` address record is the intended buyer identity | 2026-11-05 23:29 | Before live authority gate | G2/G4 | VERIFIED |
| R-D1-02 | D1 | Buyer/operator | Set the existing Sepolia-only deployer key directly in ignored local `.env`; do not send the key in chat | 2026-11-05 23:29 | Before escrow deployment | G3/G4 | VERIFIED |
| R-D1-03 | D1 | Build environment | Make solc 0.8.28 available locally or enable the Foundry compiler download | 2026-11-05 22:32 | Before contract deployment | G3/G4 | VERIFIED |

The local `.env` has a public Sepolia RPC URL and owner-only permissions. `eth_chainId` returned `11155111`; `baton.eth` resolves to the confirmed buyer identity. JobEscrow is deployed at `0x141FA2cE7805d87AEb363a2A725CAa0A0E945deC` (transaction `0xeb56aa6e3020bbcdf4dc146bcfa2a3cba3e86474820d77709a75822df32ddfb7`), with receipt, confirmations, and runtime code verified. The private deployer key remains only in ignored local `.env`. The resolver interface and live Hedera/x402 authorization path remain unverified.
