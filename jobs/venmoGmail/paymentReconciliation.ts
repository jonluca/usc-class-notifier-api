export interface PaymentReferenceRow {
  createdAt?: Date | null;
  id: string;
  paidId: string;
  semester: string;
  isPaid: boolean;
}

export interface PaymentReceiptReference {
  paidId: string;
  receivedAt: Date;
}

export type PaymentReferenceReconciliation =
  | { status: "unmatched" }
  | { status: "ambiguous"; matchingRowCount: number }
  | { status: "unmonitored"; row: PaymentReferenceRow }
  | { status: "already_paid"; row: PaymentReferenceRow }
  | { status: "eligible"; row: PaymentReferenceRow };

export function selectSinglePaymentReference(paidIds: readonly string[]): string | undefined {
  const uniquePaidIds = [...new Set(paidIds)];
  return uniquePaidIds.length === 1 ? uniquePaidIds[0] : undefined;
}

export function isReceiptEligibleForRow(
  receipt: PaymentReceiptReference,
  row: PaymentReferenceRow,
  clockSkewMs = 5 * 60 * 1000,
): boolean {
  return Boolean(row.createdAt && row.createdAt.getTime() <= receipt.receivedAt.getTime() + clockSkewMs);
}

export function reconcilePaymentReference(
  paidId: string,
  rows: readonly PaymentReferenceRow[],
  monitoredSemesters: readonly string[],
): PaymentReferenceReconciliation {
  const matchingRows = rows.filter((row) => row.paidId === paidId);
  if (matchingRows.length === 0) {
    return { status: "unmatched" };
  }

  // paidId was historically unique only within a semester. Never guess which
  // row a receipt belongs to when a cross-semester collision already exists.
  if (matchingRows.length !== 1) {
    return { status: "ambiguous", matchingRowCount: matchingRows.length };
  }

  const row = matchingRows[0]!;
  if (!monitoredSemesters.includes(row.semester)) {
    return { status: "unmonitored", row };
  }

  if (row.isPaid) {
    return { status: "already_paid", row };
  }

  return { status: "eligible", row };
}
