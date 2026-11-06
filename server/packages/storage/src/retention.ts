import type { Address, Hex } from "viem";

export const ARKIV_RETENTION_BLOCK_TIME_SECONDS = 2;
export const CHECKPOINT_RETENTION_MARGIN_DAYS = 30;
export const CHECKPOINT_RETENTION_RENEWAL_LEAD_DAYS = 45;

export function checkpointRetentionDeadline(cutoffSeconds: number, marginDays = CHECKPOINT_RETENTION_MARGIN_DAYS): Date {
  if (!Number.isSafeInteger(cutoffSeconds) || cutoffSeconds <= 0
    || !Number.isSafeInteger(marginDays) || marginDays < 1 || marginDays > 180) {
    throw new Error("ARKIV_RETENTION_CONFIG_INVALID");
  }
  return new Date((cutoffSeconds + marginDays * 24 * 60 * 60) * 1000);
}

export type RetentionEntityMetadata = { owner: Address; expiresAt: bigint };

export interface ArkivRetentionStore {
  getCurrentBlockNumber(): Promise<bigint>;
  getEntityMetadata(entityKey: Hex): Promise<RetentionEntityMetadata>;
  extendToMaximum(entityKey: Hex): Promise<bigint>;
}

export type EntityRetentionResult = {
  entityKey: Hex;
  expiresAt: bigint;
  renewed: boolean;
  covered: boolean;
  renewAtBlock: bigint;
};

/** Match the pinned Arkiv SDK's date-to-block conversion for its configured 2-second block time. */
export function estimateArkivBlockAtDate(date: Date, currentBlock: bigint, nowMs = Date.now()): bigint {
  if (Number.isNaN(date.getTime())) throw new Error("ARKIV_RETENTION_DEADLINE_INVALID");
  const secondsUntil = (date.getTime() - nowMs) / 1000;
  if (secondsUntil <= 0) return currentBlock;
  return currentBlock + BigInt(Math.ceil(secondsUntil / ARKIV_RETENTION_BLOCK_TIME_SECONDS));
}

/** Extend owner-controlled entities before their safety window closes and confirm each result. */
export async function ensureArkivEntityRetention(input: {
  store: ArkivRetentionStore;
  entityKeys: readonly Hex[];
  expectedOwner: Address;
  retentionUntilBlock: bigint;
  renewalLeadDays?: number;
}): Promise<EntityRetentionResult[]> {
  const renewalLeadDays = input.renewalLeadDays ?? CHECKPOINT_RETENTION_RENEWAL_LEAD_DAYS;
  if (!Number.isSafeInteger(renewalLeadDays) || renewalLeadDays < 1 || renewalLeadDays > 180) {
    throw new Error("ARKIV_RETENTION_CONFIG_INVALID");
  }
  const renewalLeadBlocks = BigInt(Math.ceil(
    (renewalLeadDays * 24 * 60 * 60) / ARKIV_RETENTION_BLOCK_TIME_SECONDS,
  ));
  const results: EntityRetentionResult[] = [];

  for (const entityKey of [...new Set(input.entityKeys.map((key) => key.toLowerCase()))] as Hex[]) {
    const currentBlock = await input.store.getCurrentBlockNumber();
    const before = await input.store.getEntityMetadata(entityKey);
    assertOwner(before, input.expectedOwner);
    if (before.expiresAt <= currentBlock) throw new Error("ARKIV_ENTITY_EXPIRED");

    const remainingBlocks = before.expiresAt - currentBlock;
    if (remainingBlocks > renewalLeadBlocks) {
      results.push({
        entityKey,
        expiresAt: before.expiresAt,
        renewed: false,
        covered: before.expiresAt >= input.retentionUntilBlock,
        renewAtBlock: before.expiresAt - renewalLeadBlocks,
      });
      continue;
    }

    const receiptExpiry = await input.store.extendToMaximum(entityKey);
    const after = await input.store.getEntityMetadata(entityKey);
    assertOwner(after, input.expectedOwner);
    if (after.expiresAt < receiptExpiry || after.expiresAt <= before.expiresAt) {
      throw new Error("ARKIV_RETENTION_EXTENSION_NOT_CONFIRMED");
    }
    results.push({
      entityKey,
      expiresAt: after.expiresAt,
      renewed: true,
      covered: after.expiresAt >= input.retentionUntilBlock,
      renewAtBlock: after.expiresAt - renewalLeadBlocks,
    });
  }

  return results;
}

function assertOwner(metadata: RetentionEntityMetadata, expectedOwner: Address): void {
  if (metadata.owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error("ARKIV_STORAGE_SIGNER_NOT_ENTITY_OWNER");
  }
}
