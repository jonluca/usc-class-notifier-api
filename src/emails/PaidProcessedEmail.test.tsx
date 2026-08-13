import assert from "node:assert/strict";
import test from "node:test";
import PaidProcessedEmail, { type PaidProcessedEmailProps } from "@/emails/PaidProcessedEmail";
import renderEmailTemplate from "@/emails/utilities/renderEmailTemplate";

const props = {
  verificationKey: "test-key",
  email: "student@example.com",
  sectionEntry: {
    id: "watch-id",
    createdAt: null,
    updatedAt: null,
    section: "37905",
    semester: "20263",
    lastNotified: null,
    notified: false,
    paidId: "12345678",
    isPaid: true,
    paidNotified: false,
    phoneOverride: null,
    studentId: "student-id",
    classInfoId: "class-id",
  },
  classInfo: {
    id: "class-id",
    createdAt: null,
    updatedAt: null,
    section: "37905",
    semester: "20263",
    courseNumber: "CSCI 104",
    department: "CSCI",
    courseTitle: "Data Structures",
    instructor: null,
    type: null,
    prefix: null,
    units: null,
    day: null,
    session: null,
    location: null,
    isDistanceLearning: false,
    hasDClearance: false,
  },
} as PaidProcessedEmailProps;

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
