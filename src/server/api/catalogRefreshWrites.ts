import { randomUUID } from "node:crypto";
import type { PrismaClientType } from "@/server/db";
import { getD1Executor, type D1Executor } from "@/server/d1/executor";
import { classInfoRefreshSelect, getChangedClassInfo, type ClassInfoRefreshData } from "./classInfoRefresh";

const WRITE_BATCH_SIZE = 50;
const MAX_JSON_BYTES = 256_000;
const catalogColumns = [
  "department",
  "section",
  "courseNumber",
  "courseTitle",
  "prefix",
  "semester",
  "instructor",
  "type",
  "units",
  "day",
  "location",
  "hasDClearance",
  "isCancelled",
];
const insertedColumns = ["id", "createdAt", "updatedAt", ...catalogColumns];
const quoted = (column: string) => `"${column}"`;
const upsertSql = `INSERT INTO "ClassInfo" (${insertedColumns.map(quoted).join(",")})
  SELECT ${insertedColumns.map((column) => `json_extract(value, '$.${column}')`).join(",")}
  FROM json_each(?) WHERE true
  ON CONFLICT("section", "semester") DO UPDATE SET
    ${["updatedAt", ...catalogColumns].map((column) => `${quoted(column)} = excluded.${quoted(column)}`).join(",")}
  WHERE "ClassInfo"."updatedAt" IS NULL OR "ClassInfo"."updatedAt" <= excluded."updatedAt"
  RETURNING "id"`;

async function writeD1CatalogBatch(
  executor: D1Executor,
  sections: ClassInfoRefreshData[],
  capturedAt: number,
): Promise<number> {
  const rows = sections.map((section) => ({
    ...section,
    id: randomUUID(),
    createdAt: capturedAt,
    updatedAt: capturedAt,
  }));
  const json = JSON.stringify(rows);
  if (new TextEncoder().encode(json).length > MAX_JSON_BYTES) {
    if (sections.length === 1) {
      throw new RangeError("Catalog row exceeds the bounded D1 request size");
    }
    const midpoint = Math.ceil(sections.length / 2);
    return (
      (await writeD1CatalogBatch(executor, sections.slice(0, midpoint), capturedAt)) +
      (await writeD1CatalogBatch(executor, sections.slice(midpoint), capturedAt))
    );
  }
  return (await executor.query<{ id: string }>(upsertSql, [json])).length;
}

/** Changed-only writes preserve watch foreign keys and reject older queue replays. */
export async function saveCatalogSections(
  database: PrismaClientType,
  semester: string,
  sections: ClassInfoRefreshData[],
  capturedAt = Date.now(),
): Promise<number> {
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) {
    throw new RangeError("Catalog capture time must be an epoch millisecond integer");
  }
  if (sections.some((section) => section.semester !== semester)) {
    throw new Error("Catalog semester mismatch");
  }
  const executor = getD1Executor(database);
  let changedSections = 0;
  let pending: ClassInfoRefreshData[] = [];
  for await (const section of getChangedClassInfo(
    sections,
    (sectionNumbers) =>
      database.classInfo.findMany({
        where: { semester, section: { in: sectionNumbers } },
        select: classInfoRefreshSelect,
      }),
    executor ? 80 : 250,
  )) {
    if (executor) {
      pending.push(section);
      if (pending.length === WRITE_BATCH_SIZE) {
        changedSections += await writeD1CatalogBatch(executor, pending, capturedAt);
        pending = [];
      }
    } else {
      try {
        await database.classInfo.upsert({
          where: { section_semester: { section: section.section, semester } },
          create: section,
          update: section,
          select: { id: true },
        });
        changedSections++;
      } catch (error) {
        console.error(`Error saving section ${section.section} for semester ${semester}`, error);
      }
    }
  }
  if (executor && pending.length) {
    changedSections += await writeD1CatalogBatch(executor, pending, capturedAt);
  }
  return changedSections;
}
