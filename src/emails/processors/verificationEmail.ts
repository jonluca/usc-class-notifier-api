import sendEmail from "@app/email-sender";
import VerificationEmail from "@/emails/VerificationEmail";

export const verificationEmail = async ({
  email,
  isVerifiedAlready,
  key,
}: {
  email: string;
  isVerifiedAlready: boolean;
  key: string;
}) => {
  const subject = isVerifiedAlready
    ? `Sign in to USC Schedule Helper`
    : `Verify your email for the USC Schedule Helper`;
  await sendEmail({
    EmailTemplate: VerificationEmail({ isVerifiedAlready, verificationKey: key }),
    recipient: email,
    subject,
    previewText: subject,
  });
};
