import type { Prisma } from "@app/prisma";
import type { D1Executor } from "@/server/d1/executor";
import { SECTION_SEARCH_LIMIT, sectionSearchSelect } from "./classSearchFields";

type SearchRow = Prisma.ClassInfoGetPayload<{ select: typeof sectionSearchSelect }>;
type SqlSearchRow = Omit<SearchRow, "hasDClearance" | "isCancelled"> & {
  hasDClearance: number;
  isCancelled: number;
};

const columns = Object.keys(sectionSearchSelect)
  .map((column) => `"${column}"`)
  .join(", ");
const searchableColumns = ["section", "courseNumber", "courseTitle", "department", "instructor"] as const;
const asSearchRow = (row: SqlSearchRow): SearchRow => ({
  ...row,
  hasDClearance: Boolean(row.hasDClearance),
  isCancelled: Boolean(row.isCancelled),
});

/** Literal substring matching avoids D1's 50-byte LIKE/GLOB pattern limit. */
export async function searchD1Sections(d1: D1Executor, semester: string, tokens: string[]) {
  let rows: SqlSearchRow[];
  if (tokens.every((token) => /^[\x00-\x7f]*$/.test(token))) {
    // json_each uses one bind parameter even for many short search tokens.
    rows = await d1.query<SqlSearchRow>(
      `SELECT ${columns} FROM "ClassInfo"
       WHERE semester = ? AND "isCancelled" = 0
       AND NOT EXISTS (
         SELECT 1 FROM json_each(?) AS token
         WHERE NOT (${searchableColumns.map((column) => `instr(lower(COALESCE("${column}", '')), lower(token.value)) > 0`).join(" OR ")})
       ) ORDER BY "courseNumber", section LIMIT ?`,
      [semester, JSON.stringify(tokens), SECTION_SEARCH_LIMIT + 1],
    );
  } else {
    // SQLite lower() only folds ASCII. Page through the indexed semester for
    // Unicode searches and fold in JS rather than silently changing matching.
    const needles = tokens.map((token) => token.toLowerCase());
    rows = [];
    let cursor: { courseNumber: string; section: string } | undefined;
    while (rows.length <= SECTION_SEARCH_LIMIT) {
      const page: SqlSearchRow[] = await d1.query<SqlSearchRow>(
        `SELECT ${columns} FROM "ClassInfo"
         WHERE semester = ? AND "isCancelled" = 0
         ${cursor ? 'AND ("courseNumber" > ? OR ("courseNumber" = ? AND section > ?))' : ""}
         ORDER BY "courseNumber", section LIMIT 200`,
        cursor ? [semester, cursor.courseNumber, cursor.courseNumber, cursor.section] : [semester],
      );
      for (const row of page) {
        if (needles.every((token) => searchableColumns.some((column) => row[column]?.toLowerCase().includes(token)))) {
          rows.push(row);
          if (rows.length > SECTION_SEARCH_LIMIT) {
            break;
          }
        }
      }
      if (page.length < 200) {
        break;
      }
      cursor = page.at(-1)!;
    }
  }
  return {
    sections: rows.slice(0, SECTION_SEARCH_LIMIT).map(asSearchRow),
    hasMore: rows.length > SECTION_SEARCH_LIMIT,
  };
}
