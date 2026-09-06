import { randomUUID } from "node:crypto";
import { prisma, type PrismaClientType } from "@/server/db";
import logger from "@/server/logger";
import { spotsAvailableEmail } from "@/emails/processors/spotsAvailableEmail";
import { sendMessage } from "@/server/Twilio";
import { parsePhoneNumber } from "@/utils/phoneNumber";
import { deliverAvailabilityNotification } from "./notificationDelivery";
import type { Course, Section } from "./types";

// Provider requests have 30-second deadlines. A crashed worker relinquishes
// its claim automatically; a live run finishes well before this lease expires.
export const NOTIFICATION_CLAIM_MS = 5 * 60 * 1000;

export function getAvailableSections(courses: Course[], department: string) {
  const available = new Map<string, { course: Course; section: Section }>();
  for (const course of courses) {
    // USC Basic search is full-text, not an exact department filter.
    if (course.prefix !== department) {
      continue;
    }
    for (const section of course.sections || []) {
      if (!section.isCancelled && section.totalSeats > section.registeredSeats) {
        available.set(section.sisSectionId, { course, section });
      }
    }
  }
  return available;
}

export function createAvailabilityNotifier(
  database: PrismaClientType = prisma,
  sendEmail = spotsAvailableEmail,
  sendSms = sendMessage,
) {
  return async (department: string, semester: string, courses: Course[]) => {
    const available = getAvailableSections(courses, department);
    if (!available.size) {
      return;
    }
    const watches = await database.watchedSection.findMany({
      where: {
        section: { in: [...available.keys()] },
        semester,
        notified: false,
        cancelledAt: null,
        student: { validAccount: true },
      },
      select: { id: true, section: true },
    });
    const watcherCounts = new Map<string, number>();
    for (const watch of watches) {
      watcherCounts.set(watch.section, (watcherCounts.get(watch.section) || 0) + 1);
    }

    for (const watch of watches) {
      const notificationClaimToken = randomUUID();
      const now = new Date();
      const claim = await database.watchedSection.updateMany({
        where: {
          id: watch.id,
          notified: false,
          cancelledAt: null,
          student: { validAccount: true },
          OR: [{ notificationClaimUntil: null }, { notificationClaimUntil: { lte: now } }],
        },
        data: { notificationClaimToken, notificationClaimUntil: new Date(now.getTime() + NOTIFICATION_CLAIM_MS) },
      });
      if (!claim.count) {
        continue;
      }

      try {
        // Reload after the atomic claim so another worker's completed channel
        // records and any cancellation are observed before sending.
        const current = await database.watchedSection.findFirst({
          where: { id: watch.id, notificationClaimToken, notified: false, cancelledAt: null },
          select: {
            id: true,
            section: true,
            isPaid: true,
            phoneOverride: true,
            notificationCycle: true,
            emailSentCycle: true,
            smsSentCycle: true,
            notificationClaimUntil: true,
            student: { select: { id: true, email: true, phone: true, verificationKey: true } },
          },
        });
        const offering = available.get(watch.section);
        if (
          !current ||
          !offering ||
          !current.notificationClaimUntil ||
          current.notificationClaimUntil.getTime() - Date.now() < 60_000
        ) {
          continue;
        }
        const { course, section } = offering;
        const phone = parsePhoneNumber(current.phoneOverride || "") ?? parsePhoneNumber(current.student.phone || "");
        const count = watcherCounts.get(watch.section) || 1;
        const spots = section.totalSeats - section.registeredSeats;

        await deliverAvailabilityNotification({
          emailAlreadySent: current.emailSentCycle === current.notificationCycle,
          smsAlreadySent: current.smsSentCycle === current.notificationCycle,
          sendEmail: async () => {
            await sendEmail({
              sectionEntry: section,
              course,
              email: current.student.email,
              key: current.student.verificationKey,
              numberOfStudentsWatching: count,
              section: current,
              student: current.student,
              sectionId: current.id,
            });
            const recorded = await database.$transaction(async (transaction) => {
              await transaction.notificationSent.create({
                data: { sectionId: current.id, studentId: current.student.id },
              });
              return transaction.watchedSection.updateMany({
                where: { id: current.id, notificationClaimToken, notificationCycle: current.notificationCycle },
                data: { emailSentCycle: current.notificationCycle },
              });
            });
            if (!recorded.count) {
              throw new Error("Notification cycle changed before recording email delivery");
            }
          },
          sendSms:
            current.isPaid && phone
              ? async () => {
                  await sendSms({
                    to: phone,
                    message: `${spots} ${spots === 1 ? "spot" : "spots"} available for section ${section.sisSectionId} in class ${course.fullCourseName}. ${count} ${count === 1 ? "person is" : "people are"} watching this section.`,
                  });
                  const recorded = await database.watchedSection.updateMany({
                    where: { id: current.id, notificationClaimToken, notificationCycle: current.notificationCycle },
                    data: { smsSentCycle: current.notificationCycle },
                  });
                  if (!recorded.count) {
                    throw new Error("Notification claim lost before recording SMS delivery");
                  }
                }
              : undefined,
          markNotified: async () => {
            await database.watchedSection.updateMany({
              where: {
                id: current.id,
                notificationClaimToken,
                notificationCycle: current.notificationCycle,
                cancelledAt: null,
              },
              data: { lastNotified: new Date(), notified: true },
            });
          },
        });
      } catch (error) {
        logger.error(
          `Availability notification for watch ${watch.id} remains pending; failed channels will be retried`,
          error,
        );
      } finally {
        // A delayed worker must never release a replacement worker's claim.
        await database.watchedSection.updateMany({
          where: { id: watch.id, notificationClaimToken },
          data: { notificationClaimToken: null, notificationClaimUntil: null },
        });
      }
    }
  };
}

export const notifyAvailableSections = createAvailabilityNotifier();
