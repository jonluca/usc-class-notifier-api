import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPaymentHelpUrl,
  buildPaymentSupportMailto,
  buildVenmoPaymentUrl,
  formatSemester,
} from "@/utils/venmoPayment";

test("buildVenmoPaymentUrl prefills the recipient, exact amount, and payment note", () => {
  const url = new URL(buildVenmoPaymentUrl(" 12345678 "));

  assert.equal(url.origin + url.pathname, "https://account.venmo.com/pay");
  assert.equal(url.searchParams.get("recipients"), "JonLuca");
  assert.equal(url.searchParams.get("amount"), "1.00");
  assert.equal(url.searchParams.get("note"), "12345678");
});

test("buildPaymentHelpUrl preserves only the supplied payment context", () => {
  const url = new URL(
    buildPaymentHelpUrl({
      paidId: "12345678",
      section: "37905",
      semester: "20263",
      courseNumber: "CSCI 104",
    }),
  );

  assert.equal(url.pathname, "/payment-help");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    paidId: "12345678",
    section: "37905",
    semester: "20263",
    courseNumber: "CSCI 104",
  });
});

test("buildPaymentHelpUrl omits an empty course number", () => {
  const url = new URL(
    buildPaymentHelpUrl({ paidId: "12345678", section: "37905", semester: "20263", courseNumber: " " }),
  );

  assert.equal(url.searchParams.has("courseNumber"), false);
});

test("formatSemester renders USC semester codes for people", () => {
  assert.equal(formatSemester("20261"), "Spring 2026");
  assert.equal(formatSemester("20262"), "Summer 2026");
  assert.equal(formatSemester("20263"), "Fall 2026");
});

test("formatSemester safely preserves an unknown semester", () => {
  assert.equal(formatSemester("future term"), "future term");
  assert.equal(formatSemester("  "), "Unknown semester");
});

test("buildPaymentSupportMailto prefills matching context and recovery questions", () => {
  const mailto = buildPaymentSupportMailto({
    paidId: "12345678",
    section: "37905",
    semester: "20263",
    courseNumber: "CSCI 104",
  });
  const url = new URL(mailto);

  assert.equal(url.protocol, "mailto:");
  assert.equal(url.pathname, "usc-schedule-helper@jonlu.ca");
  assert.match(url.searchParams.get("subject") || "", /CSCI 104, section 37905/);
  assert.match(url.searchParams.get("body") || "", /Semester: Fall 2026/);
  assert.match(url.searchParams.get("body") || "", /Required payment note: 12345678/);
  assert.match(url.searchParams.get("body") || "", /Payment note I actually sent:/);
});

test("buildPaymentSupportMailto strips line breaks from URL-provided context", () => {
  const mailto = buildPaymentSupportMailto({
    paidId: "12345678\r\nInjected",
    section: "37905\nInjected",
    semester: "20263",
    courseNumber: "CSCI 104\r\nInjected",
  });
  const url = new URL(mailto);

  assert.doesNotMatch(url.searchParams.get("subject") || "", /\r|\n/);
  assert.match(url.searchParams.get("body") || "", /Required payment note: 12345678 Injected/);
});
