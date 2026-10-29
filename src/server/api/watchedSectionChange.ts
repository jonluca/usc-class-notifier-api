import { TRPCError } from "@trpc/server";
import type { Prisma, WatchedSection } from "@app/prisma";
import type { PrismaClientType } from "@/server/db";
import { getValidSemesters } from "@/utils/semester";
import { assertMatchingClassInfo, assertMonitoredSemester } from "./notificationSignup";

// Before this production migration, NotificationSent recorded email delivery
// without recording SMS separately. Those historical alerts need manual review.
export const SMS_DELIVERY_TRACKING_STARTED_AT = new Date("2026-09-06T02:06:41.804Z");

export const legacyNotificationHistory = {
  where: { OR: [{ createdAt: null }, { createdAt: { lt: SMS_DELIVERY_TRACKING_STARTED_AT } }] },
  select: { id: true },
  take: 1,
} satisfies Prisma.NotificationSentFindManyArgs;

interface SectionChangeState {
  isPaid: boolean;
  cancelledAt: Date | null;
  semester: string;
  smsSentCycle: number | null;
  lastNotified: Date | null;
  notificationClaimUntil: Date | null;
  NotificationSent: { id: string }[];
}

export function getSectionChangeEligibility(
  watch: SectionChangeState,
  now = new Date(),
  monitoredSemesters = getValidSemesters(),
) {
  let reason: string | null = null;
  if (!watch.isPaid) {
    reason = "Only paid text alerts can be moved. Add a section to create a new free email alert.";
  } else if (watch.cancelledAt) {
    reason = "Resume this alert before changing its section.";
  } else if (!monitoredSemesters.includes(watch.semester)) {
    reason = "This semester is no longer being monitored.";
  } else if (watch.smsSentCycle !== null) {
    reason = "A text notification has already been sent for this paid alert.";
  } else if (
    watch.NotificationSent.length > 0 ||
    (watch.lastNotified && watch.lastNotified < SMS_DELIVERY_TRACKING_STARTED_AT)
  ) {
    reason = "This alert has older notification history. Contact support to check whether its payment can be moved.";
  } else if (watch.notificationClaimUntil && watch.notificationClaimUntil > now) {
    reason = "A notification is being processed. Please try again in a few minutes.";
  }
  return { canChangeSection: reason === null, changeSectionUnavailableReason: reason };
}

export function serializeWatchedSection<T extends WatchedSection & { NotificationSent: { id: string }[] }>(watch: T) {
  const {
    notificationClaimToken: _claimToken,
    notificationClaimUntil: _claimUntil,
    notificationCycle: _cycle,
    emailSentCycle: _emailCycle,
    smsSentCycle: _smsCycle,
    NotificationSent: _legacyHistory,
    ...section
  } = watch;
  return { ...section, ...getSectionChangeEligibility(watch) };
}

interface ChangeWatchedSectionInput {
  id: string;
  sectionNumber: string;
  semester: string;
}

export async function changeWatchedSection(
  database: PrismaClientType,
  studentId: string,
  input: ChangeWatchedSectionInput,
) {
  assertMonitoredSemester(input.semester);
  try {
    return await database.$transaction(async (transaction) => {
      // Lock the owned watch before checking delivery state. The worker's atomic
      // claim uses this same row, so a move and an SMS cannot begin concurrently.
      const owned = await transaction.$queryRaw<{ id: string }[]>`
        SELECT id FROM "WatchedSection"
        WHERE id = ${input.id} AND "studentId" = ${studentId}
        FOR UPDATE
      `;
      if (!owned.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Section not found" });
      }
      const watch = await transaction.watchedSection.findUniqueOrThrow({
        where: { id: input.id },
        include: { ClassInfo: true, NotificationSent: legacyNotificationHistory },
      });
      if (input.semester !== watch.semester) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A paid alert can only move within its original semester.",
        });
      }
      const eligibility = getSectionChangeEligibility(watch);
      if (!eligibility.canChangeSection) {
        throw new TRPCError({ code: "BAD_REQUEST", message: eligibility.changeSectionUnavailableReason! });
      }
      if (input.sectionNumber === watch.section) {
        return serializeWatchedSection(watch);
      }
      const classInfo = await transaction.classInfo.findUnique({
        where: { section_semester: { section: input.sectionNumber, semester: input.semester } },
        select: { id: true, isCancelled: true },
      });
      assertMatchingClassInfo(classInfo, input.sectionNumber, input.semester);
      const existing = await transaction.watchedSection.findUnique({
        where: {
          semester_studentId_section: { semester: input.semester, studentId, section: input.sectionNumber },
        },
        select: { id: true },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This section is already on your account, including any cancelled alert. Choose another section or contact support to move this payment.",
        });
      }
      const updated = await transaction.watchedSection.update({
        where: { id: input.id },
        data: {
          section: input.sectionNumber,
          classInfoId: classInfo.id,
          notified: false,
          lastNotified: null,
          notificationCycle: { increment: 1 },
          notificationClaimToken: null,
          notificationClaimUntil: null,
          // Keep payment/reference, phone, and all channel history on this watch.
          // In particular, never clear smsSentCycle when rearming an alert.
        },
        include: { ClassInfo: true, NotificationSent: legacyNotificationHistory },
      });
      return serializeWatchedSection(updated);
    });
  } catch (error) {
    // The unique constraint also protects against a simultaneous new signup.
    if (error instanceof Error && "code" in error && error.code === "P2002") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "You are already watching this section. Refresh your dashboard.",
      });
    }
    throw error;
  }
}
