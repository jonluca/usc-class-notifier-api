import { z } from "zod";
import type { Prisma } from "@app/prisma";
import { prisma, type PrismaClientType } from "@/server/db";
import { paidProcessedEmail } from "@/emails/processors/paidProcessedEmail";

const pageOptionsSchema = z
  .object({
    afterId: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
export interface PaidNotificationPageOptions {
  afterId?: string;
  limit?: number;
}
export interface PaidNotificationDependencies {
  database?: PrismaClientType;
  send?: (input: Parameters<typeof paidProcessedEmail>[0]) => Promise<void>;
}
export interface PaidNotificationPageResult {
  summary: { selected: number; sent: number; failed: number };
  nextCursor?: string;
}

/**
 * The scheduler's durable `paid` lease must cover this task and its continuation.
 * Sending precedes recording, preserving existing delivery semantics: a provider
 * acceptance followed by a lost response/failed write can remain ambiguous. Do not
 * blanket-retry this side-effecting task; the next cron revisits still-eligible rows.
 */
export async function runPaidNotificationPage(
  options: PaidNotificationPageOptions = {},
  dependencies: PaidNotificationDependencies = {},
): Promise<PaidNotificationPageResult> {
  const { afterId, limit } = pageOptionsSchema.parse(options);
  const database = dependencies.database ?? prisma;
  // The Worker SES transport enforces a 30-second deadline and one send attempt.
  const send = dependencies.send ?? paidProcessedEmail;
  const where: Prisma.WatchedSectionWhereInput = { isPaid: true, paidNotified: false, cancelledAt: null };
  if (afterId) {
    where.id = { gt: afterId };
  }
  const rows = await database.watchedSection.findMany({
    where,
    orderBy: { id: "asc" },
    take: limit + 1,
    include: { student: true, ClassInfo: true },
  });
  const selected = rows.slice(0, limit);
  const result: PaidNotificationPageResult = { summary: { selected: selected.length, sent: 0, failed: 0 } };
  for (const section of selected) {
    try {
      await send({
        email: section.student.email,
        verificationKey: section.student.verificationKey,
        sectionEntry: section,
        classInfo: section.ClassInfo,
      });
      const recorded = await database.watchedSection.updateMany({
        where: { id: section.id, isPaid: true, paidNotified: false, cancelledAt: null },
        data: { paidNotified: true },
      });
      if (recorded.count === 1) {
        result.summary.sent++;
      } else {
        // Delivery may already have happened, but eligibility changed before recording.
        result.summary.failed++;
      }
    } catch {
      result.summary.failed++;
    }
  }
  if (rows.length > limit) {
    result.nextCursor = selected.at(-1)!.id;
  }
  return result;
}
