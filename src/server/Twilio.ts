import tw from "twilio";
import { isProd } from "@/constants";
import logger from "@/server/logger";
import { parsePhoneNumber, PHONE_NUMBER_ERROR } from "@/utils/phoneNumber";

const { Twilio } = tw;

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_TOKEN;
const fromNumber = process.env.FROM_NUMBER;
const client = new Twilio(accountSid, authToken);

interface SmsMessageClient {
  create(options: { body: string; to: string; from: string }): Promise<{ to?: string | null }>;
}

interface SmsSenderConfig {
  accountSid: string | undefined;
  authToken: string | undefined;
  fromNumber: string | undefined;
  isProduction: boolean;
  developmentNumber: string | undefined;
  messageClient: SmsMessageClient;
}

export const normalizeUsDestination = (destination: string) => {
  return parsePhoneNumber(destination) ?? destination.trim();
};

export const sendMessageWithClient = async (
  { to, message }: { message: string; to: string },
  config: SmsSenderConfig,
) => {
  if (!config.accountSid || !config.authToken) {
    throw new Error("Cannot send text message: missing Twilio account SID or auth token");
  }
  if (!config.fromNumber) {
    throw new Error("Cannot send text message: missing Twilio sender number");
  }

  const normalizedTo = parsePhoneNumber(to);
  if (!normalizedTo) {
    throw new Error(`Cannot send text message: ${PHONE_NUMBER_ERROR}`);
  }
  const normalizedDevelopmentNumber = config.developmentNumber ? parsePhoneNumber(config.developmentNumber) : undefined;
  if (!config.isProduction && normalizedTo !== normalizedDevelopmentNumber) {
    return;
  }

  await config.messageClient.create({
    body: message,
    to: normalizedTo,
    from: config.fromNumber,
  });
  logger.debug("Sent text message");
};

export const sendMessage = async ({ to, message }: { message: string; to: string }) =>
  sendMessageWithClient(
    { to, message },
    {
      accountSid,
      authToken,
      fromNumber,
      isProduction: isProd,
      developmentNumber: process.env.TO_NUMBER,
      messageClient: {
        create: (options) => client.messages.create(options),
      },
    },
  );
