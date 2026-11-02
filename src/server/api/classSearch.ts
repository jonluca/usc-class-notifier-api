import type { Prisma } from "@app/prisma";
import type { PrismaClientType } from "@/server/db";
import { assertMonitoredSemester } from "@/server/api/notificationSignup";
import { getD1Executor } from "@/server/d1/executor";
import { searchD1Sections } from "./d1ClassSearch";

import { SECTION_SEARCH_LIMIT, sectionSearchSelect } from "./classSearchFields";
export { SECTION_SEARCH_LIMIT, sectionSearchSelect } from "./classSearchFields";

export function getSectionSearchTokens(query: string): string[] {
  // Match USC's LAW-532, LAW 532, and LAW532 spellings without converting
  // section identifiers to numbers and losing their leading zeros.
  const normalized = query
    .trim()
    .replace(/^(\d{5})[a-z]$/i, "$1")
    .replace(/^([a-z]+)(\d)/i, "$1 $2")
    .replace(/[-–—]+/g, " ");
  return normalized.split(/\s+/).filter(Boolean);
}

export function getSectionSearchWhere(semester: string, query: string): Prisma.ClassInfoWhereInput {
  const tokens = getSectionSearchTokens(query);

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
  const d1 = getD1Executor(database);
  if (d1) {
    return searchD1Sections(d1, semester, getSectionSearchTokens(query));
  }
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
