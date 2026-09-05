import sendEmail from "../utilities/sendEmail";
import type { NowWatchingEmailProps } from "@/emails/NowWatchingEmail";
import NowWatchingEmail from "@/emails/NowWatchingEmail";
import { formatSemester } from "@/utils/venmoPayment";

export const nowWatchingEmail = async (props: NowWatchingEmailProps, deliverEmail = sendEmail) => {
  const { email, sectionEntry, classInfo } = props;
  const courseNumber = classInfo?.courseNumber || "Course";
  const subject = `Watching ${courseNumber} · Section ${sectionEntry.section} · ${formatSemester(sectionEntry.semester)}`;
  await deliverEmail({
    EmailTemplate: NowWatchingEmail(props),
    recipient: email,
    subject,
    previewText: subject,
  });
};
