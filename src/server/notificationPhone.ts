import type { PrismaClientType } from "@/server/db";
import { parsePhoneNumber } from "@/utils/phoneNumber";

/**
 * Reuse a number already saved on this profile, preferring active alerts.
 * Creation order is stable: payments and notification delivery change updatedAt
 * and must not make a different number unexpectedly become the fallback.
 */
export async function getSavedNotificationPhone(
  database: Pick<PrismaClientType, "watchedSection">,
  studentId: string,
): Promise<string | null> {
  const sections = await database.watchedSection.findMany({
    where: { studentId, phoneOverride: { not: null } },
    select: { phoneOverride: true, cancelledAt: true },
    orderBy: [{ createdAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
  });

  for (const cancelled of [false, true]) {
    for (const section of sections) {
      if (Boolean(section.cancelledAt) !== cancelled) {
        continue;
      }
      const phone = parsePhoneNumber(section.phoneOverride || "");
      if (phone) {
        return phone;
      }
    }
  }
  return null;
}
