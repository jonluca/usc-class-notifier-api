import assert from "node:assert/strict";
import test from "node:test";
import PaidProcessedEmail, { type PaidProcessedEmailProps } from "@/emails/PaidProcessedEmail";
import renderEmailTemplate from "@/emails/utilities/renderEmailTemplate";

const props = {
  verificationKey: "test-key",
  email: "student@example.com",
  sectionEntry: {
    section: "37905",
    semester: "20263",
    paidId: "12345678",
  },
  classInfo: {
    courseNumber: "CSCI 104",
  },
} satisfies PaidProcessedEmailProps;

test("payment confirmation identifies the exact course, section, semester, and note", async () => {
  const html = await renderEmailTemplate(PaidProcessedEmail(props));

  assert.match(html, /Payment received for CSCI 104/);
  assert.match(html, /Section 37905/);
  assert.match(html, /Fall 2026/);
  assert.match(html, /Payment note:/);
  assert.match(html, /12345678/);
  assert.match(html, /do not need\s+to pay again/);
  assert.match(html, /\/payment-help\?/);
  assert.doesNotMatch(html, /venmo\.com\/u\/jonluca/i);
});
