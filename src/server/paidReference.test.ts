import assert from "node:assert/strict";
import test from "node:test";
import {
  generatePaidReferenceCandidates,
  PAID_REFERENCE_MAX_EXCLUSIVE,
  PAID_REFERENCE_MIN,
  needsPaidReferenceRotation,
  selectAvailablePaidReference,
  selectPaidReferenceRepairRows,
} from "./paidReference.ts";

test("generates eight-digit payment references with a cryptographic-compatible random integer source", () => {
  const calls: Array<[number, number]> = [];
  const values = [PAID_REFERENCE_MIN, PAID_REFERENCE_MAX_EXCLUSIVE - 1];

  const candidates = generatePaidReferenceCandidates(2, (min, maxExclusive) => {
    calls.push([min, maxExclusive]);
    return values[calls.length - 1]!;
  });

  assert.deepEqual(candidates, ["10000000", "99999999"]);
  assert.deepEqual(calls, [
    [PAID_REFERENCE_MIN, PAID_REFERENCE_MAX_EXCLUSIVE],
    [PAID_REFERENCE_MIN, PAID_REFERENCE_MAX_EXCLUSIVE],
  ]);
});

test("selects the first globally unused payment reference", () => {
  assert.equal(
    selectAvailablePaidReference(["12345678", "23456789", "34567890"], ["12345678", "34567890"]),
    "23456789",
  );
});

test("returns undefined when every payment reference candidate already exists", () => {
  assert.equal(selectAvailablePaidReference(["12345678", "23456789"], ["12345678", "23456789"]), undefined);
});

test("never selects an invalid generated payment reference", () => {
  assert.equal(selectAvailablePaidReference(["1234567", "not-a-code", "23456789"], []), "23456789");
});

test("rejects an invalid payment reference candidate count", () => {
  assert.throws(() => generatePaidReferenceCandidates(0), RangeError);
  assert.throws(() => generatePaidReferenceCandidates(1.5), RangeError);
});

test("rotates only unpaid legacy references that are not exactly eight digits", () => {
  assert.equal(needsPaidReferenceRotation("1234567", false), true);
  assert.equal(needsPaidReferenceRotation("12345678", false), false);
  assert.equal(needsPaidReferenceRotation("1234567", true), false);
});

test("selects only repairable legacy rows for a batch repair", () => {
  const rows = [
    { id: "legacy-unpaid", paidId: "1234567", isPaid: false },
    { id: "legacy-paid", paidId: "7654321", isPaid: true },
    { id: "current-unpaid", paidId: "12345678", isPaid: false },
  ];
  assert.deepEqual(selectPaidReferenceRepairRows(rows), [rows[0]]);
});
