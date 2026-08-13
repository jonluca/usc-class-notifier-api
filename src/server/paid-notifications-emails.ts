import "dotenv/config";

import { prisma } from "@/server/db";
import { paidProcessedEmail } from "@/emails/processors/paidProcessedEmail";
import logger from "@/server/logger";

export const sendPaidNotificationsEmails = async () => {
  // Find all sections where isPaid is true but paidNotified is false
  const sectionsToNotify = await prisma.watchedSection.findMany({
    where: {
      isPaid: true,
      paidNotified: false,
    },
    include: {
      student: true,
      ClassInfo: true,
    },
  });

  if (sectionsToNotify.length === 0) {
    return;
  }

  logger.info(`Sending ${sectionsToNotify.length} payment succeeded emails`);
  let sentCount = 0;
  let failedCount = 0;

  for (const section of sectionsToNotify) {
    try {
      await paidProcessedEmail({
        email: section.student.email,
        verificationKey: section.student.verificationKey,
        sectionEntry: section,
        classInfo: section.ClassInfo,
      });

      // Mark as notified after successful email send
      await prisma.watchedSection.update({
        where: { id: section.id },
        data: { paidNotified: true },
      });
      sentCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  if (failedCount > 0) {
    logger.error(`Payment notification batch completed with ${sentCount} sent and ${failedCount} failed`);
  } else {
    logger.info(`Payment notification batch completed: ${sentCount} sent, 0 failed`);
  }
};
