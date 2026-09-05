import assert from "node:assert/strict";
import test from "node:test";
import { nowWatchingEmail } from "./nowWatchingEmail";
import type sendEmail from "../utilities/sendEmail";

test("builds the watch email from supplied class metadata without a database lookup", async () => {
  const messages: Parameters<typeof sendEmail>[0][] = [];
  await nowWatchingEmail(
    {
      email: "student@example.com",
      verificationKey: "verification-key",
      sectionEntry: { semester: "20263", section: "12345", paidId: "12345678" },
      classInfo: { courseNumber: "CSCI-104" },
      isVerifiedAccount: true,
    },
    async (message) => {
      messages.push(message);
    },
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.subject, "Watching CSCI-104 · Section 12345 · Fall 2026");
  assert.equal(messages[0]?.recipient, "student@example.com");
});
