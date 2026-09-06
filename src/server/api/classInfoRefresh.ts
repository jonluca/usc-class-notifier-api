import type { Prisma } from "@app/prisma";

export const classInfoRefreshSelect = {
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

export type ClassInfoRefreshData = Prisma.ClassInfoGetPayload<{ select: typeof classInfoRefreshSelect }>;

// SAFETY: These keys come from the same select used to define ClassInfoRefreshData.
const fields = Object.keys(classInfoRefreshSelect) as (keyof ClassInfoRefreshData)[];
const READ_BATCH_SIZE = 250;

/** Compare only catalog-owned fields; preserve IDs, watch relations, and unchanged timestamps. */
export async function* getChangedClassInfo(
  sections: ClassInfoRefreshData[],
  findExisting: (sectionNumbers: string[]) => Promise<ClassInfoRefreshData[]>,
) {
  // A department response can repeat a section through cross-listed courses.
  // Match the former upsert loop's final value without writing intermediate versions.
  const uniqueSections = [...new Map(sections.map((section) => [section.section, section])).values()];
  for (let offset = 0; offset < uniqueSections.length; offset += READ_BATCH_SIZE) {
    const batch = uniqueSections.slice(offset, offset + READ_BATCH_SIZE);
    const existing = new Map(
      (await findExisting(batch.map((section) => section.section))).map((section) => [section.section, section]),
    );
    for (const section of batch) {
      const previous = existing.get(section.section);
      if (!previous || fields.some((field) => previous[field] !== section[field])) {
        yield section;
      }
    }
  }
}
