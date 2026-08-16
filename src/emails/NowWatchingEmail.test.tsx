import assert from "node:assert/strict";
import test from "node:test";
import NowWatchingEmail, { type NowWatchingEmailProps } from "@/emails/NowWatchingEmail";
import renderEmailTemplate from "@/emails/utilities/renderEmailTemplate";

const props = {
  verificationKey: "test-key",
  email: "student@example.com",
  sectionEntry: {
    section: "37905",
    semester: "20263",
    paidId: "12345678",
  },
  classInfo: null,
  showVenmoInfo: false,
} satisfies Omit<NowWatchingEmailProps, "isVerifiedAccount">;

test("unverified accounts receive an activation link", async () => {
  const html = await renderEmailTemplate(NowWatchingEmail({ ...props, isVerifiedAccount: false }));

  assert.match(html, /Verify Email &amp; View Dashboard/);
  assert.match(html, /\/verify\?key=test-key/);
});

test("verified accounts link directly to their dashboard", async () => {
  const html = await renderEmailTemplate(NowWatchingEmail({ ...props, isVerifiedAccount: true }));

  assert.match(html, />View Dashboard</);
  assert.match(html, /\/dashboard\?key=test-key/);
});

test("text alert instructions use one prefilled payment link and an exact eight-digit note", async () => {
  const html = await renderEmailTemplate(
    NowWatchingEmail({
      ...props,
      isVerifiedAccount: true,
      showVenmoInfo: true,
      classInfo: {
        courseNumber: "CSCI 104",
      },
    }),
  );

  assert.match(html, /CSCI 104/);
  assert.match(html, /Section 37905/);
  assert.match(html, /Fall 2026/);
  assert.match(html, /Required Venmo payment note/);
  assert.match(html, /12345678/);
  assert.match(html, /Pay exactly \$1\.00 in Venmo/);
  assert.match(html, /one separate \$1\.00 payment for each section/);
  assert.match(html, /up to 20 minutes/);
  assert.match(html, /\/payment-help\?/);
  assert.equal(html.match(/https:\/\/account\.venmo\.com\/pay/g)?.length, 1);
  assert.doesNotMatch(html, /venmo\.com\/u\/jonluca/i);
  assert.doesNotMatch(html, /venmo:\/\//i);
});
