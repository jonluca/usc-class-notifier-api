import { z } from "zod";
import { isProd } from "../../src/constants.ts";
import { parsePhoneNumber, PHONE_NUMBER_ERROR } from "../../src/utils/phoneNumber.ts";
import { readBoundedText } from "../../src/server/d1/protocol.ts";

type Fetcher = (request: Request) => Promise<Response>;
interface SmsConfiguration {
  accountSid: string | undefined;
  apiKeySid?: string;
  authToken: string | undefined;
  fromNumber: string | undefined;
  developmentNumber?: string;
  isProduction: boolean;
}
const messageReceiptSchema = z.object({ sid: z.string().regex(/^SM[0-9a-fA-F]{32}$/) });
export const normalizeUsDestination = (destination: string) => parsePhoneNumber(destination) ?? destination.trim();

export async function sendWorkerMessage(
  { to, message }: { to: string; message: string },
  configuration: SmsConfiguration,
  fetcher: Fetcher = (request) => fetch(request),
): Promise<void> {
  if (!configuration.accountSid || !configuration.authToken) {
    throw new Error("Cannot send text message: missing Twilio account SID or credentials");
  }
  if (
    !/^AC[0-9a-fA-F]{32}$/.test(configuration.accountSid) ||
    (configuration.apiKeySid && !/^SK[0-9a-fA-F]{32}$/.test(configuration.apiKeySid))
  ) {
    throw new Error("Cannot send text message: invalid Twilio account configuration");
  }
  if (!configuration.fromNumber) {
    throw new Error("Cannot send text message: missing Twilio sender number");
  }
  const normalizedTo = parsePhoneNumber(to);
  if (!normalizedTo) {
    throw new Error(`Cannot send text message: ${PHONE_NUMBER_ERROR}`);
  }
  const developmentNumber = configuration.developmentNumber
    ? parsePhoneNumber(configuration.developmentNumber)
    : undefined;
  if (!configuration.isProduction && normalizedTo !== developmentNumber) {
    return;
  }
  try {
    const response = await fetcher(
      new Request(`https://api.twilio.com/2010-04-01/Accounts/${configuration.accountSid}/Messages.json`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Basic ${btoa(`${configuration.apiKeySid ?? configuration.accountSid}:${configuration.authToken}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ Body: message, To: normalizedTo, From: configuration.fromNumber }),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Twilio delivery failed (${response.status})`);
    }
    messageReceiptSchema.parse(JSON.parse(await readBoundedText(response.body, 65_536)));
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new DOMException("Twilio delivery timed out", "TimeoutError");
    }
    if (error instanceof Error && /^Twilio delivery failed \([1-5]\d{2}\)$/.test(error.message)) {
      throw error;
    }
    throw new Error("Twilio delivery failed");
  }
}

export const sendMessage = (input: { to: string; message: string }) =>
  sendWorkerMessage(input, {
    accountSid: process.env.TWILIO_SID,
    apiKeySid: process.env.TWILIO_API_KEY_SID,
    authToken: process.env.TWILIO_API_KEY_SID ? process.env.TWILIO_API_KEY_SECRET : process.env.TWILIO_TOKEN,
    fromNumber: process.env.FROM_NUMBER,
    developmentNumber: process.env.TO_NUMBER,
    isProduction: isProd,
  });
