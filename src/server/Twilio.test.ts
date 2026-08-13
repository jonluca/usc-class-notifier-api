import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUsDestination, sendMessageWithClient } from "./Twilio.ts";

test("normalizes plain and formatted 10-digit US destinations to E.164", () => {
  assert.equal(normalizeUsDestination("2135551212"), "+12135551212");
  assert.equal(normalizeUsDestination("(213) 555-1212"), "+12135551212");
  assert.equal(normalizeUsDestination(" +12135551212 "), "+12135551212");
  assert.equal(normalizeUsDestination("1 (213) 555-1212"), "+12135551212");
  assert.equal(normalizeUsDestination("+44 20 7946 0958"), "+442079460958");
});

test("does not reinterpret extended or malformed destinations", () => {
  assert.equal(normalizeUsDestination("213-555-1212 ext 4"), "213-555-1212 ext 4");
  assert.equal(normalizeUsDestination("5551212"), "5551212");
});

test("rejects invalid stored destinations before calling Twilio", async () => {
  let called = false;
  await assert.rejects(
    sendMessageWithClient(
      { to: "213-555-1212 ext 4", message: "A spot opened" },
      {
        accountSid: "test-sid",
        authToken: "test-token",
        fromNumber: "+13105551212",
        isProduction: true,
        developmentNumber: undefined,
        messageClient: {
          create: async () => {
            called = true;
            return {};
          },
        },
      },
    ),
    /Enter a valid phone number/,
  );
  assert.equal(called, false);
});

test("awaits Twilio and propagates provider failures with a normalized destination", async () => {
  const providerError = new Error("Twilio unavailable");
  let destination: string | undefined;

  await assert.rejects(
    sendMessageWithClient(
      { to: "(213) 555-1212", message: "A spot opened" },
      {
        accountSid: "test-sid",
        authToken: "test-token",
        fromNumber: "+13105551212",
        isProduction: true,
        developmentNumber: undefined,
        messageClient: {
          create: async (options) => {
            destination = options.to;
            throw providerError;
          },
        },
      },
    ),
    (error) => error === providerError,
  );

  assert.equal(destination, "+12135551212");
});

test("missing Twilio configuration rejects instead of reporting success", async () => {
  await assert.rejects(
    sendMessageWithClient(
      { to: "2135551212", message: "A spot opened" },
      {
        accountSid: undefined,
        authToken: "test-token",
        fromNumber: "+13105551212",
        isProduction: true,
        developmentNumber: undefined,
        messageClient: {
          create: async () => ({ to: "+12135551212" }),
        },
      },
    ),
    /missing Twilio account SID or auth token/,
  );
});
