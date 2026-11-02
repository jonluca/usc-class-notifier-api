import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { sendWorkerMessage } from "./twilio.ts";
import { sendWorkerEmail } from "./sendEmail.ts";

const sms = {
  accountSid: `AC${"1".repeat(32)}`,
  apiKeySid: `SK${"2".repeat(32)}`,
  authToken: "synthetic-secret",
  fromNumber: "+12125550000",
  isProduction: true,
};

test("Worker SMS preserves normalization and form fields, fixed origin, API-key auth and timeout signal", async () => {
  let calls = 0;
  await sendWorkerMessage(
    { to: "(213) 555-0123", message: "Synthetic notification & symbols" },
    sms,
    async (request) => {
      calls++;
      assert.equal(request.url, `https://api.twilio.com/2010-04-01/Accounts/${sms.accountSid}/Messages.json`);
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "manual");
      assert.equal(request.signal.aborted, false);
      assert.equal(request.headers.get("authorization"), `Basic ${btoa(`${sms.apiKeySid}:${sms.authToken}`)}`);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(await request.text())), {
        Body: "Synthetic notification & symbols",
        To: "+12135550123",
        From: sms.fromNumber,
      });
      return Response.json({ sid: `SM${"3".repeat(32)}`, to: "+12135550123" }, { status: 201 });
    },
  );
  assert.equal(calls, 1);
});

test("Worker SMS has no retry, sanitizes upstream failures and honors destination/development gates", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response("recipient@example.invalid secret", { status: 429 });
  };
  await assert.rejects(
    sendWorkerMessage({ to: "+12135550123", message: "test" }, sms, fetcher),
    /^Error: Twilio delivery failed \(429\)$/,
  );
  assert.equal(calls, 1);
  await assert.rejects(sendWorkerMessage({ to: "invalid", message: "test" }, sms, fetcher), /valid/);
  await sendWorkerMessage(
    { to: "+12135550123", message: "test" },
    { ...sms, isProduction: false, developmentNumber: "+12125559999" },
    fetcher,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    sendWorkerMessage({ to: "+12135550123", message: "test" }, sms, async () => {
      throw new DOMException("sensitive request URL", "AbortError");
    }),
    { name: "TimeoutError", message: "Twilio delivery timed out" },
  );
});

const email = {
  EmailTemplate: createElement("p", null, "Synthetic email body"),
  recipient: "usc-schedule-helper@jonlu.ca",
  subject: "Synthetic subject",
  previewText: "Synthetic plain text",
};
const emailCredentials = { accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret" };

test("Worker SES retains existing sender, templates, text and abort deadline", async () => {
  let calls = 0;
  await sendWorkerEmail(email, emailCredentials, {
    async send(command, options) {
      calls++;
      assert.equal(command.input.Source, "USC Schedule Helper <schedule-helper@jonlu.ca>");
      assert.deepEqual(command.input.Destination?.ToAddresses, [email.recipient]);
      assert.equal(command.input.Message?.Subject?.Data, email.subject);
      assert.equal(command.input.Message?.Body?.Text?.Data, email.previewText);
      assert.match(command.input.Message?.Body?.Html?.Data ?? "", /Synthetic email body/);
      assert.equal(options?.abortSignal.aborted, false);
      return { $metadata: { httpStatusCode: 200 }, MessageId: "synthetic-message" };
    },
  });
  assert.equal(calls, 1);
});

test("Worker SES rejects absent secrets, never retries and excludes provider data from errors", async () => {
  let calls = 0;
  const client = {
    async send() {
      calls++;
      throw new Error("recipient@example.invalid synthetic-secret");
    },
  };
  await assert.rejects(
    sendWorkerEmail(email, { accessKeyId: undefined, secretAccessKey: undefined }, client),
    /credentials are missing/,
  );
  assert.equal(calls, 0);
  await assert.rejects(sendWorkerEmail(email, emailCredentials, client), /^Error: SES delivery failed$/);
  assert.equal(calls, 1);
  await assert.rejects(
    sendWorkerEmail(email, emailCredentials, {
      async send() {
        throw new DOMException("sensitive credential or URL", "AbortError");
      },
    }),
    { name: "TimeoutError", message: "SES delivery timed out" },
  );
});

test("native workerd renders email and signs SES over fetch, without Node credentials or real sends", async () => {
  const { build } = await import("esbuild");
  const { Miniflare } = await import("miniflare");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { sendWorkerEmail } from './deploy/scheduler/sendEmail.ts';
        import { sendWorkerMessage } from './deploy/scheduler/twilio.ts';
        export default { async fetch() {
          await sendWorkerEmail({EmailTemplate:createElement('p',null,'Synthetic Worker email'),recipient:'synthetic@example.invalid',subject:'Worker subject',previewText:'Worker plain text'},
            {accessKeyId:'synthetic-access',secretAccessKey:'synthetic-secret'});
          await sendWorkerMessage({to:'+12135550123',message:'Synthetic Worker SMS'},
            {accountSid:'AC${"1".repeat(32)}',authToken:'synthetic-secret',fromNumber:'+12125550000',isProduction:true});
          return Response.json({sent:true});
        }};
      `,
      resolveDir: root,
      sourcefile: "scheduler-transports-test.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@aws-sdk/xml-builder": `${root}node_modules/@aws-sdk/xml-builder/dist-cjs/index.js` },
    external: ["node:*"],
    plugins: [
      {
        name: "worker-no-dotenv",
        setup(builder) {
          builder.onResolve({ filter: /^dotenv\/config$/ }, () => ({ path: "dotenv", namespace: "empty" }));
          builder.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export {}" }));
        },
      },
    ],
  });
  let emailCalls = 0;
  let smsCalls = 0;
  let emailFails = false;
  let simulationError: Error | undefined;
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: async (request: Request) => {
      try {
        const url = new URL(request.url);
        assert.equal(request.method, "POST");
        const form = new URLSearchParams(await request.text());
        if (url.hostname === "email.us-east-1.amazonaws.com") {
          emailCalls++;
          assert.match(request.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=synthetic-access\//);
          assert.equal(form.get("Action"), "SendEmail");
          assert.equal(form.get("Destination.ToAddresses.member.1"), "synthetic@example.invalid");
          assert.equal(form.get("Message.Subject.Data"), "Worker subject");
          assert.match(form.get("Message.Body.Html.Data") ?? "", /Synthetic Worker email/);
          if (emailFails) {
            return new Response(
              "<ErrorResponse><Error><Type>Receiver</Type><Code>ServiceUnavailable</Code><Message>recipient@example.invalid synthetic-secret</Message></Error><RequestId>synthetic-request</RequestId></ErrorResponse>",
              { status: 503, headers: { "content-type": "text/xml" } },
            );
          }
          return new Response(
            '<SendEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendEmailResult><MessageId>synthetic-message</MessageId></SendEmailResult><ResponseMetadata><RequestId>synthetic-request</RequestId></ResponseMetadata></SendEmailResponse>',
            { headers: { "content-type": "text/xml" } },
          );
        }
        assert.equal(url.hostname, "api.twilio.com");
        smsCalls++;
        assert.equal(form.get("To"), "+12135550123");
        assert.equal(form.get("Body"), "Synthetic Worker SMS");
        return Response.json({ sid: `SM${"3".repeat(32)}` }, { status: 201 });
      } catch (error) {
        simulationError = error instanceof Error ? error : new Error("Simulation failed");
        throw error;
      }
    },
  });
  try {
    const response = await mf.dispatchFetch("https://local.invalid/");
    assert.ifError(simulationError);
    assert.equal(emailCalls, 1);
    assert.equal(smsCalls, 1);
    if (!response.ok) {
      assert.fail(await response.text());
    }
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sent: true });
    assert.equal(emailCalls, 1);
    assert.equal(smsCalls, 1);
    emailFails = true;
    const failure = await mf.dispatchFetch("https://local.invalid/failure");
    assert.equal(failure.status, 500);
    const failureText = await failure.text();
    assert.match(failureText, /SES delivery failed \(503\)/);
    assert.equal(failureText.includes("recipient@example.invalid"), false);
    assert.equal(failureText.includes("synthetic-secret"), false);
    assert.equal(emailCalls, 2);
    assert.equal(smsCalls, 1);
  } finally {
    await mf.dispose();
  }
});
