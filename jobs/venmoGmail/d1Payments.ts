import type { D1Executor } from "@/server/d1/executor";

/** Recheck receipt ownership, age and eligibility in the same write statement. */
export async function markD1PaymentPaid(
  d1: D1Executor,
  candidate: { rowId: string; paidId: string; receiptCutoff: Date; semester?: string },
  requireUnnotified = false,
) {
  if (!Number.isFinite(candidate.receiptCutoff.getTime())) {
    throw new Error("Invalid receipt cutoff");
  }
  const rows = await d1.query<{ id: string }>(
    `UPDATE "WatchedSection" SET "isPaid" = 1, "updatedAt" = ?
     WHERE id = ? AND "paidId" = ? AND "isPaid" = 0
       AND "createdAt" IS NOT NULL AND "createdAt" <= ?
       ${requireUnnotified ? 'AND "paidNotified" = 0' : ""}
       ${candidate.semester ? "AND semester = ?" : ""}
       AND (SELECT COUNT(*) FROM "WatchedSection" WHERE "paidId" = ?) = 1
     RETURNING id`,
    [
      Date.now(),
      candidate.rowId,
      candidate.paidId,
      candidate.receiptCutoff.getTime(),
      ...(candidate.semester ? [candidate.semester] : []),
      candidate.paidId,
    ],
  );
  return rows.length;
}

export interface D1PaymentPreflight {
  totalRowCount: number;
  duplicatePaidIdGroupCount: number;
  legacyNonEightDigitPaidIdRowCount: number;
  inconsistentUnpaidButNotifiedRowCount: number;
  missingCreatedAtRowCount: number;
}

export async function getD1PaymentPreflight(d1: D1Executor): Promise<D1PaymentPreflight> {
  const [row] = await d1.query<D1PaymentPreflight>(`
    SELECT COUNT(*) AS totalRowCount,
      COALESCE(SUM(CASE WHEN length("paidId") != 8 OR "paidId" GLOB '*[^0-9]*' THEN 1 ELSE 0 END), 0) AS legacyNonEightDigitPaidIdRowCount,
      COALESCE(SUM(CASE WHEN "isPaid" = 0 AND "paidNotified" = 1 THEN 1 ELSE 0 END), 0) AS inconsistentUnpaidButNotifiedRowCount,
      COALESCE(SUM(CASE WHEN "createdAt" IS NULL THEN 1 ELSE 0 END), 0) AS missingCreatedAtRowCount,
      (SELECT COUNT(*) FROM (SELECT "paidId" FROM "WatchedSection" GROUP BY "paidId" HAVING COUNT(*) > 1)) AS duplicatePaidIdGroupCount
    FROM "WatchedSection"`);
  if (!row || Object.values(row).some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Database preflight returned invalid counts");
  }
  return row;
}
