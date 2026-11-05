# BATON input queue

Times are Asia/Kolkata. Secrets must be entered into the local `.env`/keystore, never this file or chat.

| ID | Requester | Responsible person | Item/action | Requested at | Needed by | Gate | State |
|---|---|---|---|---|---|---|---|
| R-D1-01 | D1 | Buyer/operator | Confirm that the Sepolia `baton.eth` address record is the intended buyer identity | 2026-11-05 23:29 | Before live authority gate | G2/G4 | VERIFIED |
| R-D1-02 | D1 | Buyer/operator | Set the existing Sepolia-only deployer key directly in ignored local `.env`; do not send the key in chat | 2026-11-05 23:29 | Before escrow deployment | G3/G4 | VERIFIED |
| R-D1-03 | D1 | Build environment | Make solc 0.8.28 available locally or enable the Foundry compiler download | 2026-11-05 22:32 | Before contract deployment | G3/G4 | VERIFIED |
| R-D1-04 | D1 | Buyer/operator | Set Worker A's Arkiv access key in the checkout root `.env`; use the actual value privately, since the source variable is absent and dotenv does not expand variable references | 2026-11-06 03:52 | Before live Arkiv write/read | G5 | REQUESTED |
| R-D1-05 | D1/D2 | Buyer/operator | Provide Worker B's Arkiv access and signer in B's local environment before B recovery | 2026-11-06 03:52 | Before two-worker recovery | G8 | REQUESTED |
| R-D1-06 | D1/D2 | Buyer/operator | Configure the live Hedera x402 endpoint/facilitator and coordinate the joint A-to-B recovery run | 2026-11-06 03:52 | Before live payment-crash gate | G8/G12 | REQUESTED |
| R-D2-02 | D2 | Buyer/operator | Confirm Worker B host availability and its separate worker directory for cold recovery | 2026-11-05 22:21 | Before two-worker recovery | G8 | REQUESTED |
| R-D2-04 | D2 | Buyer/operator | Define Arkiv entity ownership and renewal authority before enabling content writes | 2026-11-06 01:32 | Before first live Arkiv write | G5 | REQUESTED |

The local `.env` has a public Sepolia RPC URL, owner-only permissions, and a Worker A Arkiv signer that derives to A's public address. `ARKIV_ACCESS_KEY` remains missing. The live Sepolia lifecycle is the regression baseline; the exact release label is **Sepolia lifecycle: LIVE_PASS; full integration: pending.** The restricted shell could not inspect or restart the existing server process; see `plan.md` for the environment precedence and handoff details. No private key or access-key value is recorded here.

ENS resolver/name and scoped grant checks passed live on Sepolia. BATON's adapter address remains distinct from the resolver address. Arkiv content write/readback, B-host cold recovery, and a real Hedera x402 settlement have not been demonstrated; the API payment provider remains a local fixture. The local SQLite, gateway, recovery, admission, and worker modules provide implementation scaffolding for those remaining integration gates.
