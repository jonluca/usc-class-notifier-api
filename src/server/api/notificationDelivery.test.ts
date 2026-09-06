import assert from "node:assert/strict";
import test from "node:test";
import { deliverAvailabilityNotification, NotificationChannelError } from "./notificationDelivery.ts";

test("an email failure still attempts SMS and leaves the watch pending", async () => {
  const calls: string[] = [];
  const providerError = new Error("SES unavailable");

  await assert.rejects(
    deliverAvailabilityNotification({
      emailAlreadySent: false,
      sendEmail: async () => {
        calls.push("email");
        throw providerError;
      },
      sendSms: async () => {
        calls.push("sms");
      },
      markNotified: async () => {
        calls.push("mark");
      },
    }),
    (error) =>
      error instanceof NotificationChannelError && error.channel === "email" && error.originalError === providerError,
  );

  assert.deepEqual(calls, ["email", "sms"]);
});

test("an SMS failure leaves the watch pending after a successful email", async () => {
  const calls: string[] = [];
  const providerError = new Error("Twilio unavailable");

  await assert.rejects(
    deliverAvailabilityNotification({
      emailAlreadySent: false,
      sendEmail: async () => {
        calls.push("email");
      },
      sendSms: async () => {
        calls.push("sms");
        throw providerError;
      },
      markNotified: async () => {
        calls.push("mark");
      },
    }),
    (error) =>
      error instanceof NotificationChannelError && error.channel === "sms" && error.originalError === providerError,
  );

  assert.deepEqual(calls, ["email", "sms"]);
});

test("a recorded email is not resent while retrying SMS", async () => {
  const calls: string[] = [];

  await deliverAvailabilityNotification({
    emailAlreadySent: true,
    sendEmail: async () => {
      calls.push("email");
    },
    sendSms: async () => {
      calls.push("sms");
    },
    markNotified: async () => {
      calls.push("mark");
    },
  });

  assert.deepEqual(calls, ["sms", "mark"]);
});

test("an email-only notification is marked after email succeeds", async () => {
  const calls: string[] = [];

  await deliverAvailabilityNotification({
    emailAlreadySent: false,
    sendEmail: async () => {
      calls.push("email");
    },
    markNotified: async () => {
      calls.push("mark");
    },
  });

  assert.deepEqual(calls, ["email", "mark"]);
});

test("a slow email never blocks SMS and successful SMS is skipped on an email retry", async () => {
  const email = Promise.withResolvers<void>();
  let smsCount = 0;
  let marked = false;
  const delivery = deliverAvailabilityNotification({
    emailAlreadySent: false,
    sendEmail: () => email.promise,
    sendSms: async () => {
      smsCount += 1;
    },
    markNotified: async () => {
      marked = true;
    },
  });
  assert.equal(smsCount, 1);
  assert.equal(marked, false);
  const failed = assert.rejects(delivery, NotificationChannelError);
  email.reject(new Error("SES unavailable"));
  await failed;
  await deliverAvailabilityNotification({
    emailAlreadySent: false,
    smsAlreadySent: true,
    sendEmail: async () => {},
    sendSms: async () => {
      smsCount += 1;
    },
    markNotified: async () => {
      marked = true;
    },
  });
  assert.equal(smsCount, 1);
  assert.equal(marked, true);
});

test("both channel failures are retained and the watch stays pending", async () => {
  await assert.rejects(
    deliverAvailabilityNotification({
      emailAlreadySent: false,
      sendEmail: async () => {
        throw new Error("SES unavailable");
      },
      sendSms: async () => {
        throw new Error("Twilio unavailable");
      },
      markNotified: async () => assert.fail("A failed delivery must remain pending"),
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((failure) => failure.channel),
        ["email", "sms"],
      );
      return true;
    },
  );
});
