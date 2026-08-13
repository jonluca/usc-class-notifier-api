import sendEmail from "../utilities/sendEmail";
import type { NowWatchingEmailProps } from "@/emails/NowWatchingEmail";
import NowWatchingEmail from "@/emails/NowWatchingEmail";
import { prisma } from "@/server/db";
import { formatSemester } from "@/utils/venmoPayment";

export const nowWatchingEmail = async (props: NowWatchingEmailProps) => {
  const { email, sectionEntry } = props;
  const classInfo = await prisma.classInfo.findFirst({
    where: {
      semester: sectionEntry.semester,
      section: sectionEntry.section,
    },
  });
  const courseNumber = classInfo?.courseNumber || "Course";
  const subject = `Watching ${courseNumber} · Section ${sectionEntry.section} · ${formatSemester(sectionEntry.semester)}`;
  await sendEmail({
    EmailTemplate: NowWatchingEmail({ ...props, classInfo }),
    recipient: email,
    subject,
    previewText: subject,
  });
};
