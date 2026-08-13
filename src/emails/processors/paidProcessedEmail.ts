import sendEmail from "../utilities/sendEmail";
import type { PaidProcessedEmailProps } from "@/emails/PaidProcessedEmail";
import PaidProcessedEmail from "@/emails/PaidProcessedEmail";
import { prisma } from "@/server/db";
import { formatSemester } from "@/utils/venmoPayment";

export const paidProcessedEmail = async (props: PaidProcessedEmailProps) => {
  const { email, sectionEntry } = props;
  const classInfo = await prisma.classInfo.findFirst({
    where: {
      semester: sectionEntry.semester,
      section: sectionEntry.section,
    },
  });
  const courseNumber = classInfo?.courseNumber || "Course";
  const subject = `Payment received · ${courseNumber} · Section ${sectionEntry.section} · ${formatSemester(sectionEntry.semester)}`;
  await sendEmail({
    EmailTemplate: PaidProcessedEmail({ ...props, classInfo }),
    recipient: email,
    subject,
    previewText: subject,
  });
};
