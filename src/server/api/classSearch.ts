import type { Prisma } from "@app/prisma";
import type { PrismaClientType } from "@/server/db";
import { assertMonitoredSemester } from "@/server/api/notificationSignup";

export const SECTION_SEARCH_LIMIT = 50;

export const sectionSearchSelect = {
  id: true,
  department: true,
  section: true,
  courseNumber: true,
  courseTitle: true,
  prefix: true,
  semester: true,
  instructor: true,
  type: true,
  units: true,
  day: true,
  location: true,
  hasDClearance: true,
  isCancelled: true,
} satisfies Prisma.ClassInfoSelect;

export function getSectionSearchWhere(semester: string, query: string): Prisma.ClassInfoWhereInput {
  // Match USC's LAW-532, LAW 532, and LAW532 spellings without converting
  // section identifiers to numbers and losing their leading zeros.
  const normalized = query
    .trim()
    .replace(/^(\d{5})[a-z]$/i, "$1")
    .replace(/^([a-z]+)(\d)/i, "$1 $2")
    .replace(/[-–—]+/g, " ");
  const tokens = normalized.split(/\s+/).filter(Boolean);

  return {
    semester,
    isCancelled: false,
    AND: tokens.map((token) => {
      // Prisma's PostgreSQL contains filter uses LIKE; user input is literal.
      const contains = token.replace(/[\\%_]/g, "\\$&");
      return {
        OR: [
          { section: { contains, mode: "insensitive" } },
          { courseNumber: { contains, mode: "insensitive" } },
          { courseTitle: { contains, mode: "insensitive" } },
          { department: { contains, mode: "insensitive" } },
          { instructor: { contains, mode: "insensitive" } },
        ],
      };
    }),
  };
}

export async function searchSections(database: Pick<PrismaClientType, "classInfo">, semester: string, query: string) {
  assertMonitoredSemester(semester);
  const sections = await database.classInfo.findMany({
    where: getSectionSearchWhere(semester, query),
    select: sectionSearchSelect,
    orderBy: [{ courseNumber: "asc" }, { section: "asc" }],
    take: SECTION_SEARCH_LIMIT + 1,
  });

  return {
    sections: sections.slice(0, SECTION_SEARCH_LIMIT),
    hasMore: sections.length > SECTION_SEARCH_LIMIT,
  };
}
