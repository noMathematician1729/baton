# BATON input queue

Times are Asia/Kolkata. Secrets must be entered into the local `.env`/keystore, never this file or chat.

| ID | Requester | Responsible person | Item/action | Requested at | Needed by | Gate | State |
|---|---|---|---|---|---|---|---|
| R-D1-01 | D1 | Buyer/operator | Confirm that the Sepolia `baton.eth` address record is the intended buyer identity | 2026-11-05 23:29 | Before live authority gate | G2/G4 | VERIFIED |
| R-D1-02 | D1 | Buyer/operator | Set the existing Sepolia-only deployer key directly in ignored local `.env`; do not send the key in chat | 2026-11-05 23:29 | Before escrow deployment | G3/G4 | VERIFIED |
| R-D1-03 | D1 | Build environment | Make solc 0.8.28 available locally or enable the Foundry compiler download | 2026-11-05 22:32 | Before contract deployment | G3/G4 | VERIFIED |

The local `.env` has a public Sepolia RPC URL and owner-only permissions. `eth_chainId` returned `11155111`; `baton.eth` resolves to the confirmed buyer identity. The user reports ENSv2 scoped grant/revoke/wrong-job checks passed with resolver `0x583fDD4b8d345624B1B8438Bd8ca5004bD0352bA` and adapter `0xD659F372D2439075F29e39f5E005d86352Da1A6c`. The current `BATON_ESCROW_ADDRESS` is `0x4F802976810690F984cd05640a23b3FFB5B395E1`; its deployment transaction hash is not in tracked evidence. Worker A/B signer addresses were checked locally. The funded Sepolia job `0xcef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3` completed without escrow redeployment: A withdrew 3 test tokens and B withdrew 7, with 17 successful transaction receipts at two confirmations. Stale A reverted with `StaleEpoch` in a simulated call. Full evidence is in `evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json`. No private key is recorded here.
