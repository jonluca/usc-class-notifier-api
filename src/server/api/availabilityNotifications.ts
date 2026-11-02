import { randomUUID } from "node:crypto";
import { prisma, type PrismaClientType } from "@/server/db";
import logger from "@/server/logger";
import { spotsAvailableEmail } from "@/emails/processors/spotsAvailableEmail";
import { sendMessage } from "@/server/Twilio";
import { resolveNotificationPhone } from "@/utils/notificationPhone";
import { getSavedNotificationPhone } from "@/server/notificationPhone";
import { getD1Executor } from "@/server/d1/executor";
import { recordD1EmailDelivery } from "@/server/d1/criticalWrites";
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

export interface AvailabilityPage {
  afterWatchId?: string;
  limit?: number;
}
export interface AvailabilityPageResult {
  /** Selected candidates, including claims another worker already holds. */
  processedWatches: number;
  completedWatches: number;
  failedWatches: number;
  nextCursor?: string;
}

export function createAvailabilityNotifier(
  database: PrismaClientType = prisma,
  sendEmail = spotsAvailableEmail,
  sendSms = sendMessage,
) {
  return async (
    department: string,
    semester: string,
    courses: Course[],
    page: AvailabilityPage = {},
  ): Promise<AvailabilityPageResult> => {
    if (page.limit !== undefined && (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 50)) {
      throw new RangeError("Availability page limit must be between 1 and 50");
    }
    const available = getAvailableSections(courses, department);
    if (!available.size) {
      return { processedWatches: 0, completedWatches: 0, failedWatches: 0 };
    }
    const sectionNumbers = [...available.keys()];
    // Leave room for semester/status parameters under D1's 100-bind limit.
    const batchSize = getD1Executor(database) || page.limit !== undefined ? 80 : sectionNumbers.length;
    const candidates = new Map<string, { id: string; section: string }>();
    const watcherCounts = new Map<string, number>();
    for (let offset = 0; offset < sectionNumbers.length; offset += batchSize) {
      const where = {
        section: { in: sectionNumbers.slice(offset, offset + batchSize) },
        semester,
        notified: false,
        cancelledAt: null,
        student: { validAccount: true },
      };
      const batch = await database.watchedSection.findMany({
        where: { ...where, id: page.afterWatchId === undefined ? undefined : { gt: page.afterWatchId } },
        select: { id: true, section: true },
        orderBy: { id: "asc" },
        take: page.limit === undefined ? undefined : page.limit + 1,
      });
      for (const watch of batch) {
        candidates.set(watch.id, watch);
      }
      if (page.limit !== undefined) {
        // The displayed count covers the section, not just this notification page.
        const counts = await database.watchedSection.groupBy({
          by: ["section"],
          where,
          _count: { _all: true },
        });
        for (const count of counts) {
          watcherCounts.set(count.section, count._count._all);
        }
      }
    }
    // Each section chunk contributes its first limit+1 IDs. Merge before slicing
    // so a later chunk cannot hide an earlier ID behind the continuation cursor.
    const ordered = [...candidates.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    const watches = page.limit === undefined ? ordered : ordered.slice(0, page.limit);
    const nextCursor = page.limit !== undefined && ordered.length > page.limit ? watches.at(-1)?.id : undefined;
    if (page.limit === undefined) {
      for (const watch of watches) {
        watcherCounts.set(watch.section, (watcherCounts.get(watch.section) || 0) + 1);
      }
    }

    let completedWatches = 0;
    let failedWatches = 0;
    for (const watch of watches) {
      const notificationClaimToken = randomUUID();
      const now = new Date();
      const claim = await database.watchedSection.updateMany({
        where: {
          id: watch.id,
          section: watch.section,
          semester,
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
          where: {
            id: watch.id,
            section: watch.section,
            semester,
            notificationClaimToken,
            notified: false,
            cancelledAt: null,
          },
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
        const explicitPhone = resolveNotificationPhone({
          sectionPhone: current.phoneOverride,
          accountPhone: current.student.phone,
        });
        const phone =
          explicitPhone ?? (current.isPaid ? await getSavedNotificationPhone(database, current.student.id) : null);
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
            const d1 = getD1Executor(database);
            if (d1) {
              await recordD1EmailDelivery(d1, {
                id: current.id,
                studentId: current.student.id,
                claimToken: notificationClaimToken,
                notificationCycle: current.notificationCycle,
              });
              return;
            }
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
                    // A user can rearm while Twilio is accepting this text. Its
                    // successful send must remain durable even if the cycle changed.
                    where: { id: current.id, notificationClaimToken },
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
        completedWatches++;
      } catch (error) {
        failedWatches++;
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
    return { processedWatches: watches.length, completedWatches, failedWatches, nextCursor };
  };
}

export const notifyAvailableSections = createAvailabilityNotifier();
