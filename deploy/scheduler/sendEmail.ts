import { SESClient } from "@aws-sdk/client-ses";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { z } from "zod";
import sendEmail, { type SesEmailClient } from "../../src/emails/utilities/sendEmail.ts";

interface EmailCredentials {
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  sessionToken?: string;
}
const failureSchema = z.object({ $metadata: z.object({ httpStatusCode: z.number().int().min(100).max(599) }) });

/** Explicit Worker secrets; browser SDK credential discovery intentionally has no fallback. */
export async function sendWorkerEmail(
  input: Parameters<typeof sendEmail>[0],
  credentials: EmailCredentials,
  injectedClient?: SesEmailClient,
): Promise<void> {
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new Error("SES credentials are missing");
  }
  const client =
    injectedClient ??
    new SESClient({
      region: "us-east-1",
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
      requestHandler: new FetchHttpHandler({ requestTimeout: 30_000 }),
      maxAttempts: 1,
    });
  try {
    // Preserve the existing template, plain text, sender, recipient and production gate.
    await sendEmail(input, client);
  } catch (error) {
    const parsed = failureSchema.safeParse(error);
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new DOMException("SES delivery timed out", "TimeoutError");
    }
    throw new Error(
      parsed.success ? `SES delivery failed (${parsed.data.$metadata.httpStatusCode})` : "SES delivery failed",
    );
  }
}

export default (input: Parameters<typeof sendEmail>[0]) =>
  sendWorkerEmail(input, {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  });
