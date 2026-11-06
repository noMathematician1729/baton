# D1 handover

Updated: 6 November 2026 (Asia/Kolkata)

## Current checkout

- Repository: `/Users/ashwera/Desktop/baton/baton`
- Branch: `build/audit-g0-g4`
- `HEAD` and `origin/build/audit-g0-g4`: `410315b` (`feat: wire confirmed Sepolia escrow mutations`)
- Tracked worktree changes: none at handoff.
- Existing untracked paths: `.agents/`, `runtime-recovery-audit.md`, and `skills-lock.json`. They predate this handoff; preserve them and do not stage them.
- This handoff is the only intended new file. Keep secrets and local ledgers out of Git.

Continue on this branch unless the user directs otherwise. For each code checkpoint, run the relevant local checks, commit, and push immediately. Avoid Sepolia, Hedera, and Arkiv writes unless the user asks for that live step; the current D1 follow-up is local-only.

## Team boundaries

You are D1. Own escrow and ENS authority, gateway authorization and money transitions, chain mutation wiring, and the D1 portions of G0–G4. D2 owns the provider adapter and paid-output recovery integration, Arkiv write/read and retention, clean-host worker recovery, and G5/G6 end-to-end takeover work. Coordinate on shared protocol boundaries and review D2's changes, but do not implement D2's assigned work in parallel.

The user's standing direction is explicit: do not work outside D1's scope, avoid unnecessary testnet spend, and push after each commit.

## Latest D1 checkpoint

`410315b` added the production Sepolia escrow mutation writer and gateway wiring. Buyer-controlled mutations are simulated, submitted, confirmed, then checked against a confirmed full chain snapshot before local state advances. Workers sign milestone offers and takeover acknowledgements themselves; a worker claim is relayed only after validating its signed transaction's chain, escrow, calldata, value, and recovered sender. Production mutation routes require chain authority, the writer, and the buyer signer. No worker private key is loaded by the buyer gateway.

The code was locally checked at that checkpoint:

- Offline Node suite: 58/58 passed.
- `npm run typecheck` and `npm run build` passed.
- `npm run test:local`, `npm run test:signing`, `npm run contracts:compile`, and `npm run key-service:smoke` passed.
- Foundry: 12/12 passed with pinned solc 0.8.28 using the documented isolated offline wrapper.
- `git diff --check` passed; ignored env and local ledger files were not staged.

These are local/fake-backed checks. The latest HTTP restart integration still needs a rerun on the user's Mac: this execution environment denied loopback listeners with `EPERM`. There is no transaction journal that automatically repairs the unusual case where a write lands but the confirmed post-write snapshot disagrees; the gateway fails closed and leaves local state unchanged, requiring reconciliation.

## Live evidence and claims

Keep the release wording exact: **“Sepolia lifecycle: LIVE_PASS; full integration: pending.”**

The historical Sepolia lifecycle for job `cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3` completed 17 confirmed transactions on the earlier escrow ABI: A withdrew 3 test tokens, B withdrew 7, takeover reached epoch 2, and escrow token balance ended at zero. Stale A rejection passed by simulation. Public receipts are in `evidence/sepolia-jobs/cef05316864dba8ad054580dfe6ca880341c6420ea5ac46c067aa5e2fb8f0de3.json`.

That evidence is a regression baseline only. The revised V2 escrow has not been deployed or exercised live. Do not rerun the lifecycle against the old escrow, redeploy, or spend Sepolia funds as a local test. The ENS resolver and BATON authority adapter are separate addresses. Live Arkiv writes, a live accepted-head grant, x402 settlement, and separate-host recovery are not established by the local fixtures.

## D1 work to continue

### 1. Finish the local G4 x402 challenge policy boundary

This is the active D1 follow-up. `server/services/provider/hederaX402.ts` currently builds an x402 client and wraps `fetch`, but does not install a challenge filter. Keep D2's provider adapter file untouched unless D2 asks for a coordinated interface change.

Implement a small pure policy helper in D1-owned gateway code, then unit-test fixtures without network access. Inspect the installed `@x402/core` type declarations first so the helper matches the actual v2 API. The policy should allow only requirements satisfying all configured constraints:

- x402 version 2 and exact-payment scheme;
- the expected Hedera network;
- exact approved asset and `payTo` identity;
- a positive integer atomic-unit amount no greater than the operation's approved cap;
- a timeout within the configured maximum;
- the expected trusted `extra.feePayer` identity.

Filter the offered requirements down to acceptable candidates and fail closed when none remain. Do not sign or submit anything in this helper. Hedera's challenge identifies a fee payer but does not state a numeric facilitator fee; pin and validate that identity, and do not describe the transfer cap as a fee cap. Add fixture tests for a valid challenge and wrong version, scheme, network, asset, payee, fee payer, malformed/zero/over-cap amount, excessive timeout, and no acceptable candidate. Keep live payment and D2's settlement/output lookup out of this task.

After this helper is locally tested, update `plan.md`, `docs/gates.md`, `test.md`, and `README.md` to say the challenge policy is locally verified while provider wiring and live settlement remain pending. Preserve the precise release label above.

### 2. Close remaining D1-only G0 items

- Reconstruct focused regression assertions from `runtime-recovery-audit.md`; the original probe scripts are not in the checkout.
- Reconcile pinned dependency/compiler parity and review the recorded `solc`/temporary-file advisories. Do not force-upgrade dependencies blindly; preserve solc 0.8.28 behavior and document any unresolved exposure.
- Ask the user to rerun the latest API restart test on their Mac, where TCP loopback is available:

  ```sh
  node --import tsx --test server/src/app.integration.test.ts
  ```

  Earlier revision passed 1/1 on Mac; the version after the job-provisioning journal change has not yet been verified there.

### 3. Track G1/G2 limits without spending testnet

Local contract regressions and chain writer wiring are complete at the checkpoint. Remaining live D1 proof requires review and deployment of the V2 escrow, then a deliberate funded mutation run. This is not part of the x402 helper task. Coordinate with D2 on the shared checkpoint/locator boundary; the golden fixture belongs to that shared boundary and must not be invented independently.

## D2-owned remaining work

Do not take over these tasks: real provider challenge/payment/status/output integration; paid-output persistence and Arkiv readback; accepted-head key grant against a real checkpoint; buyer-owned Arkiv write/read and retention; B recovery from a clean host; tunnel decision; durable drain/takeover reopening; and the joint real Hedera → Arkiv → Sepolia → A failure → B recovery scenario, including the no-double-payment crash case. D1 can review the authority and ledger boundaries and provide the already-pushed mutation writer.

## Local verification commands

From the repository root:

```sh
npm run typecheck
npm run build
node --import tsx --test \
  server/packages/*/src/*.test.ts \
  server/apps/worker/src/*.test.ts \
  server/services/*/*.test.ts \
  server/src/app.routes.test.ts \
  server/src/domain/jobs/*.test.ts \
  server/src/chain/*.test.ts \
  server/src/services/*/*.test.ts
```

The direct Node suite avoids the restricted `tsx --test` IPC launcher and does not bind a TCP port. It uses fakes/local fixtures and does not contact Sepolia, Arkiv, Hedera, or a paid provider. For contract checks, see the pinned-solc instructions in `test.md`; do not use deployment commands as tests.

Before committing, inspect the staged file list and verify `.env`, `.env.key-service`, `.env.worker-a`, `.env.worker-b`, private keys, SQLite ledgers, and local evidence are excluded. Do not print secret values. Commit the tested D1 checkpoint and push it to `origin/build/audit-g0-g4` immediately.
