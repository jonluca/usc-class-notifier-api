import sendEmail from "../utilities/sendEmail";
import type { SpotsAvailableEmailProps } from "@/emails/SpotsAvailableEmail";
import SpotsAvailableEmail from "@/emails/SpotsAvailableEmail";
import logger from "@/server/logger";

export const spotsAvailableEmail = async (
  props: SpotsAvailableEmailProps & {
    section: { id: string };
    student: { id: string };
  },
) => {
  const { email, sectionEntry, course } = props;
  const spotsAvailable = sectionEntry.totalSeats - sectionEntry.registeredSeats;
  const className = course.fullCourseName;
  const spotText = spotsAvailable === 1 ? "spot" : "spots";
  const subject = `${spotsAvailable} ${spotText} open for ${className}!`;
  const sectionId = props.section.id;
  // The notifier persists history and this cycle's progress together after
  // sending, so a committed history row can never lose its retry marker.
  await sendEmail({
    EmailTemplate: SpotsAvailableEmail(props),
    recipient: email,
    subject,
    previewText: subject,
  });
  logger.info(`Sent spots available email to ${email} for ${sectionId} - ${className}`);
};
