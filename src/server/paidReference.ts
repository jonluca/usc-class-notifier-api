import { randomInt } from "node:crypto";

export const PAID_REFERENCE_MIN = 10_000_000;
export const PAID_REFERENCE_MAX_EXCLUSIVE = 100_000_000;
export const PAID_REFERENCE_CANDIDATE_COUNT = 20;
export const PAID_REFERENCE_PATTERN = /^\d{8}$/;

// All API instances use this transaction-scoped PostgreSQL advisory lock before
// assigning a payment reference. The number is stable and private to this app.
export const PAID_REFERENCE_ALLOCATION_LOCK_ID = 8_578_367_167_080_773n;

export type RandomInteger = (min: number, maxExclusive: number) => number;

export function generatePaidReferenceCandidates(
  count = PAID_REFERENCE_CANDIDATE_COUNT,
  randomInteger: RandomInteger = randomInt,
): string[] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError("Payment reference candidate count must be a positive integer");
  }

  return Array.from({ length: count }, () => String(randomInteger(PAID_REFERENCE_MIN, PAID_REFERENCE_MAX_EXCLUSIVE)));
}

export function selectAvailablePaidReference(
  candidates: readonly string[],
  existingPaidReferences: Iterable<string>,
): string | undefined {
  const existing = new Set(existingPaidReferences);
  return candidates.find((candidate) => PAID_REFERENCE_PATTERN.test(candidate) && !existing.has(candidate));
}

export function needsPaidReferenceRotation(paidId: string, isPaid: boolean): boolean {
  return !isPaid && !PAID_REFERENCE_PATTERN.test(paidId);
}

export interface RepairablePaidReferenceRow {
  id: string;
  paidId: string;
  isPaid: boolean;
}

export function selectPaidReferenceRepairRows(
  rows: readonly RepairablePaidReferenceRow[],
): RepairablePaidReferenceRow[] {
  return rows.filter((row) => needsPaidReferenceRotation(row.paidId, row.isPaid));
}
