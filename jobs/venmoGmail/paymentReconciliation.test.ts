import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcilePaymentReference,
  isReceiptEligibleForRow,
  selectSinglePaymentReference,
  type PaymentReferenceRow,
} from "./paymentReconciliation.ts";

const row = (overrides: Partial<PaymentReferenceRow> = {}): PaymentReferenceRow => ({
  id: "row-current",
  paidId: "12345678",
  semester: "20263",
  isPaid: false,
  ...overrides,
});

test("reports a payment reference with no database match", () => {
  assert.deepEqual(reconcilePaymentReference("12345678", [], ["20263"]), { status: "unmatched" });
});

test("rejects cross-semester collisions even if only one row is monitored", () => {
  assert.deepEqual(
    reconcilePaymentReference("12345678", [row(), row({ id: "row-expired", semester: "20253" })], ["20263"]),
    { status: "ambiguous", matchingRowCount: 2 },
  );
});

test("does not activate a payment reference for an unmonitored semester", () => {
  const expiredRow = row({ semester: "20253" });
  assert.deepEqual(reconcilePaymentReference("12345678", [expiredRow], ["20263"]), {
    status: "unmonitored",
    row: expiredRow,
  });
});

test("recognizes an already-paid monitored row without updating it", () => {
  const paidRow = row({ isPaid: true });
  assert.deepEqual(reconcilePaymentReference("12345678", [paidRow], ["20263"]), {
    status: "already_paid",
    row: paidRow,
  });
});

test("returns only the one eligible monitored row", () => {
  const eligibleRow = row();
  assert.deepEqual(reconcilePaymentReference("12345678", [row({ paidId: "87654321" }), eligibleRow], ["20263"]), {
    status: "eligible",
    row: eligibleRow,
  });
});

test("accepts exactly one unique reference from a receipt", () => {
  assert.equal(selectSinglePaymentReference(["12345678"]), "12345678");
  assert.equal(selectSinglePaymentReference(["12345678", "12345678"]), "12345678");
});

test("rejects receipts containing zero or multiple references", () => {
  assert.equal(selectSinglePaymentReference([]), undefined);
  assert.equal(selectSinglePaymentReference(["12345678", "87654321"]), undefined);
});

test("accepts only a receipt that is not older than its watched section", () => {
  const receivedAt = new Date("2026-08-13T10:00:00.000Z");
  assert.equal(
    isReceiptEligibleForRow(
      { paidId: "12345678", receivedAt },
      row({ createdAt: new Date("2026-08-13T10:05:00.000Z") }),
    ),
    true,
  );
  assert.equal(
    isReceiptEligibleForRow(
      { paidId: "12345678", receivedAt },
      row({ createdAt: new Date("2026-08-13T10:05:00.001Z") }),
    ),
    false,
  );
  assert.equal(isReceiptEligibleForRow({ paidId: "12345678", receivedAt }, row({ createdAt: null })), false);
});
