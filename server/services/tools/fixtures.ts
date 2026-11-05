import { createHash } from "node:crypto";

export const syntheticBatches = {
  "batch-1": [
    { id: "r-03", value: 12 },
    { id: "r-01", value: 7 },
    { id: "r-02", value: 9 },
  ],
  "batch-2": [
    { id: "r-06", value: 15 },
    { id: "r-04", value: 4 },
    { id: "r-05", value: 11 },
  ],
  "batch-3": [
    { id: "r-09", value: 3 },
    { id: "r-07", value: 8 },
    { id: "r-08", value: 14 },
  ],
} as const;

export type BatchId = keyof typeof syntheticBatches;

export function digestFixture(value: unknown): string {
  return "0x" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function processBatch(batchId: BatchId) {
  const rows = [...syntheticBatches[batchId]].sort((left, right) => left.id.localeCompare(right.id));
  return {
    batchId,
    rows,
    count: rows.length,
    sum: rows.reduce((total, row) => total + row.value, 0),
    outputDigest: digestFixture(rows),
  };
}
