import "dotenv/config";
import { SESClient, SendEmailCommand, type SendEmailCommandOutput } from "@aws-sdk/client-ses";
import renderEmailTemplate from "./renderEmailTemplate";
import type React from "react";
import { isProd } from "@/constants";

export interface SesEmailClient {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>;
}

const sendEmail = async (
  {
    EmailTemplate,
    recipient,
    subject,
    previewText,
  }: {
    EmailTemplate: React.ReactElement;
    recipient: string;
    subject: string;
    previewText: string;
  },
  client: SesEmailClient = new SESClient({ region: "us-east-1" }),
) => {
  if (!isProd && recipient !== "usc-schedule-helper@jonlu.ca") {
    recipient = "usc-schedule-helper@jonlu.ca";
  }

  const html = await renderEmailTemplate(EmailTemplate);

  const params = {
    Source: "USC Schedule Helper <schedule-helper@jonlu.ca>",
    Destination: {
      ToAddresses: [recipient],
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: "UTF-8",
      },
      Body: {
        Text: {
          Data: previewText,
          Charset: "UTF-8",
        },
        Html: {
          Data: html,
          Charset: "UTF-8",
        },
      },
    },
  };

  const command = new SendEmailCommand(params);
  await client.send(command);
};

export default sendEmail;
