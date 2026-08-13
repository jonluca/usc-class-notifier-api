import assert from "node:assert/strict";
import test from "node:test";
import { formatPhoneNumberForDisplay, parsePhoneNumber } from "./phoneNumber.ts";

test("normalizes common US phone formats to E.164", () => {
  for (const input of [
    "2135551212",
    "(213) 555-1212",
    "213-555-1212",
    "213.555.1212",
    "213 555 1212",
    "1 (213) 555-1212",
    "+1 (213) 555-1212",
    "tel:+1 (213) 555-1212",
    "213-555-1212 text only",
    "mobile: 213.555.1212",
  ]) {
    assert.equal(parsePhoneNumber(input), "+12135551212", input);
  }
});

test("accepts explicit international numbers with common separators", () => {
  assert.equal(parsePhoneNumber("+44 20 7946 0958"), "+442079460958");
  assert.equal(parsePhoneNumber("+33 1 42 68 53 00"), "+33142685300");
});

test("rejects ambiguous, extended, and malformed numbers", () => {
  for (const input of [
    "",
    "5551212",
    "442079460958",
    "213-555-1212 ext 4",
    "213-555-1212 ext",
    "213-555-1212 x4",
    "213-555-1212 x",
    "213-555-1212 #",
    "555-1212 ext 213",
    "213-555-121 x2",
    "+1 213-555-121 x2",
    "1-800-FLOWERS",
    "+0123456789",
    "+1 213 555 121",
    "+1 213 555 12123",
    "+44 (0)20 7946 0958",
    "+39 (0)2 12345678",
    "+44 20 7946 (0)958",
    "++1 213 555 1212",
    "213-555-1212 or 310-555-1212",
  ]) {
    assert.equal(parsePhoneNumber(input), null, input);
  }
});

test("formats canonical US numbers without changing international numbers", () => {
  assert.equal(formatPhoneNumberForDisplay("+12135551212"), "(213) 555-1212");
  assert.equal(formatPhoneNumberForDisplay("+442079460958"), "+442079460958");
});
