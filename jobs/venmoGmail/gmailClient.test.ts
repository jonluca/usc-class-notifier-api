import assert from "node:assert/strict";
import test from "node:test";
import { isExpectedVenmoPaymentSubject, parseVenmoPaidIds } from "./venmoEmail.ts";

test("accepts a paid-you subject for the expected one-dollar amount", () => {
  assert.equal(isExpectedVenmoPaymentSubject("Alex paid you $1.00"), true);
  assert.equal(
    isExpectedVenmoPaymentSubject(
      "Alex paid $1.00 to your Venmo account. Leave it in Venmo or transfer it to your bank account.",
    ),
    true,
  );
});

test("rejects paid-you subjects for another or missing amount", () => {
  assert.equal(isExpectedVenmoPaymentSubject("Alex paid you $0.01"), false);
  assert.equal(isExpectedVenmoPaymentSubject("Alex paid you $2.00"), false);
  assert.equal(isExpectedVenmoPaymentSubject("Alex paid you"), false);
  assert.equal(isExpectedVenmoPaymentSubject("Alex requested $1.00"), false);
  assert.equal(isExpectedVenmoPaymentSubject("Alex paid your $1.00 request"), false);
  assert.equal(isExpectedVenmoPaymentSubject("Alex canceled a $1.00 request"), false);
});

test("parses an eight-digit Venmo note", () => {
  assert.deepEqual(parseVenmoPaidIds("Payment note: 12345678"), ["12345678"]);
  assert.deepEqual(parseVenmoPaidIds('Payment note\n"87654321"'), ["87654321"]);
  assert.deepEqual(parseVenmoPaidIds("Code 40449471"), ["40449471"]);
});

test("keeps support for an eight-digit note on its own line", () => {
  assert.deepEqual(parseVenmoPaidIds("Alex paid you\n\n12345678\nThank you"), ["12345678"]);
  assert.deepEqual(parseVenmoPaidIds("99330973 (text notifications) BUAD 307 Section #14838"), ["99330973"]);
});

test("does not treat transaction identifiers as paid IDs", () => {
  assert.deepEqual(parseVenmoPaidIds("Transaction ID: 12345678"), []);
  assert.deepEqual(parseVenmoPaidIds("Transaction ID\n12345678"), []);
  assert.deepEqual(parseVenmoPaidIds("Receipt number: 87654321"), []);
});

test("ignores numbers that are not exactly eight digits", () => {
  assert.deepEqual(parseVenmoPaidIds("Note: 1234567\nMemo: 123456789\nTransaction ID: 1234567890123456789"), []);
});

test("deduplicates repeated paid IDs", () => {
  assert.deepEqual(parseVenmoPaidIds("Note: 12345678\n12345678\nMemo: 12345678"), ["12345678"]);
});
