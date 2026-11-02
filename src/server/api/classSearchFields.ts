import type { Prisma } from "@app/prisma";

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
