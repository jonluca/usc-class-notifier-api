export type NotificationChannel = "email" | "sms";

export class NotificationChannelError extends Error {
  constructor(
    public readonly channel: NotificationChannel,
    public readonly originalError: Error,
  ) {
    super(`Failed to send ${channel} notification`);
    this.name = "NotificationChannelError";
  }
}

export const deliverAvailabilityNotification = async ({
  emailAlreadySent,
  smsAlreadySent = false,
  sendEmail,
  sendSms,
  markNotified,
}: {
  emailAlreadySent: boolean;
  smsAlreadySent?: boolean;
  sendEmail: () => Promise<void>;
  sendSms?: () => Promise<void>;
  markNotified: () => Promise<void>;
}) => {
  const deliver = async (channel: NotificationChannel, send: () => Promise<void>) => {
    try {
      await send();
    } catch (error) {
      const providerError = error instanceof Error ? error : new Error(String(error));
      throw new NotificationChannelError(channel, providerError);
    }
  };

  // Start both channels even if one provider is down. Each callback persists
  // its own success before returning, so a retry only sends missing channels.
  const results = await Promise.allSettled([
    emailAlreadySent ? Promise.resolve() : deliver("email", sendEmail),
    !sendSms || smsAlreadySent ? Promise.resolve() : deliver("sms", sendSms),
  ]);
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Availability notification channels failed");
  }

  await markNotified();
};
