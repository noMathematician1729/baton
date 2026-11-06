# BATON input queue

Times are Asia/Kolkata. Secrets must be entered into the local `.env`/keystore, never this file or chat.

| ID | Requester | Responsible person | Item/action | Requested at | Needed by | Gate | State |
|---|---|---|---|---|---|---|---|
| R-D1-01 | D1 | Buyer/operator | Confirm that the Sepolia `baton.eth` address record is the intended buyer identity | 2026-11-05 23:29 | Before live authority gate | G2/G4 | VERIFIED |
| R-D1-02 | D1 | Buyer/operator | Set the existing Sepolia-only deployer key directly in ignored local `.env`; do not send the key in chat | 2026-11-05 23:29 | Before escrow deployment | G3/G4 | VERIFIED |
| R-D1-03 | D1 | Build environment | Restore pinned solc 0.8.28 in the installed toolchain and resolve the lockfile's `tmp` advisory | 2026-11-05 22:32 | Before contract deployment | G1/G0 | BLOCKED_IN_SANDBOX |
| R-D1-04 | D1 | Buyer/operator | Set Worker A's Arkiv access key in the checkout root `.env`; use the actual value privately, since the source variable is absent and dotenv does not expand variable references | 2026-11-06 03:52 | Before live Arkiv write/read | G3 | CONFIGURED |
| R-D1-05 | D1/D2 | Buyer/operator | Provide Worker B's Arkiv access and signer in B's local environment before B recovery | 2026-11-06 03:52 | Before two-worker recovery | G8 | REQUESTED |
| R-D1-06 | D1/D2 | Buyer/operator | Configure the live Hedera x402 endpoint/facilitator and coordinate the joint A-to-B recovery run | 2026-11-06 03:52 | Before live payment-crash gate | G8/G12 | REQUESTED |
| R-D2-02 | D2 | Buyer/operator | Confirm Worker B host availability and its separate worker directory for cold recovery | 2026-11-05 22:21 | Before two-worker recovery | G8 | REQUESTED |
| R-D2-04 | D2 | Buyer/operator | Define Arkiv entity ownership and renewal authority before enabling content writes | 2026-11-06 01:32 | Before first live Arkiv write | G5 | REQUESTED |
| R-D1-07 | D1 | Buyer/operator | Configure Arkiv RPC/signer privately; run the buyer-host key service; add B's exact accepted-checkpoint grant; use a temporary HTTPS tunnel only if D2 confirms a separate host | 2026-11-06 | Before live Arkiv cold recovery | G3 | PARTIAL_LOCAL |
| R-D1-08 | D1/D2 | Buyer/operator | Confirm Worker B's separate host and worker-specific recovery/tool credentials without sharing keys | 2026-11-06 | Before B-host recovery | G3/G4 | REQUESTED |

The checkout-root `.env` is ignored and mode `0600`. `ARKIV_ACCESS_KEY` and a validly formatted checkpoint encryption key are present; `ARKIV_RPC_URL` and `ARKIV_SIGNER_PRIVATE_KEY` remain absent. The ignored `.env.key-service`, `.env.worker-a`, and `.env.worker-b` files are provisioned locally with mode `0600`; worker tokens are subject-bound and URLs are loopback for same-laptop use. D2 will confirm whether a separate host requires a tunnel. No grant for a live accepted checkpoint is recorded. No secret values are included here.

ENS resolver/name and scoped grant checks passed live on Sepolia. BATON's adapter address remains distinct from the resolver address. Arkiv content write/readback, B-host cold recovery, and a real Hedera x402 settlement have not been demonstrated; the API payment provider remains a local fixture. The current G0–G4 candidate passes local code, ledger, contract, and key-service fixture checks, but has not been run against live Arkiv/key-service/payment services.
