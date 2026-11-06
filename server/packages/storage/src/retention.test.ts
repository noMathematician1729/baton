import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateArkivBlockAtDate, ensureArkivEntityRetention } from "./retention.js";
import type { ArkivRetentionStore } from "./retention.js";
import type { Address, Hex } from "viem";

const owner = ("0x" + "1".repeat(40)) as Address;
const otherOwner = ("0x" + "2".repeat(40)) as Address;
const entityKey = ("0x" + "a".repeat(64)) as Hex;
const currentBlock = 100n;

test("Arkiv retention date conversion follows the SDK's two-second block estimate", () => {
  const now = 1_800_000_000_000;
  assert.equal(estimateArkivBlockAtDate(new Date(now + 3_000), currentBlock, now), currentBlock + 2n);
  assert.equal(estimateArkivBlockAtDate(new Date(now - 1), currentBlock, now), currentBlock);
});

test("retention renews near-expiry entities and confirms expiry readback", async () => {
  const fake = fakeStore(1_000n);
  const result = await ensureArkivEntityRetention({
    store: fake.store,
    entityKeys: [entityKey, entityKey],
    expectedOwner: owner,
    retentionUntilBlock: 50_000n,
    renewalLeadDays: 1,
  });

  assert.equal(fake.extendCalls, 1);
  assert.deepEqual(result, [{
    entityKey,
    expiresAt: 90_000n,
    renewed: true,
    covered: true,
    renewAtBlock: 46_800n,
  }]);
});

test("retention schedules a future renewal when the target exceeds the current maximum horizon", async () => {
  const fake = fakeStore(50_000n);
  const result = await ensureArkivEntityRetention({
    store: fake.store,
    entityKeys: [entityKey],
    expectedOwner: owner,
    retentionUntilBlock: 90_000n,
    renewalLeadDays: 1,
  });

  assert.equal(fake.extendCalls, 0);
  assert.equal(result[0]?.covered, false);
  assert.equal(result[0]?.renewAtBlock, 6_800n);
});

test("retention rejects a different owner and an unconfirmed extension", async () => {
  const wrongOwner = fakeStore(1_000n, otherOwner);
  await assert.rejects(ensureArkivEntityRetention({
    store: wrongOwner.store,
    entityKeys: [entityKey],
    expectedOwner: owner,
    retentionUntilBlock: 50_000n,
    renewalLeadDays: 1,
  }), /ARKIV_STORAGE_SIGNER_NOT_ENTITY_OWNER/);

  const failedExtension = fakeStore(1_000n);
  failedExtension.store.extendToMaximum = async () => 50_000n;
  await assert.rejects(ensureArkivEntityRetention({
    store: failedExtension.store,
    entityKeys: [entityKey],
    expectedOwner: owner,
    retentionUntilBlock: 50_000n,
    renewalLeadDays: 1,
  }), /ARKIV_RETENTION_EXTENSION_NOT_CONFIRMED/);
});

function fakeStore(initialExpiry: bigint, entityOwner = owner) {
  let expiresAt = initialExpiry;
  let extendCalls = 0;
  const store: ArkivRetentionStore = {
    async getCurrentBlockNumber() { return currentBlock; },
    async getEntityMetadata() { return { owner: entityOwner, expiresAt }; },
    async extendToMaximum() {
      extendCalls += 1;
      expiresAt = 90_000n;
      return expiresAt;
    },
  };
  return {
    store,
    get extendCalls() { return extendCalls; },
  };
}
