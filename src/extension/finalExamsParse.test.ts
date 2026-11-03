import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FINAL_EXAMS_FALLBACK } from "@/extension/finalExamsFallback";
import {
  DEPARTMENT_CODES,
  normalizeCourseKey,
  parseExamDate,
  parseExceptionCourses,
  parseFinalExamSchedule,
  parseHourRange,
  termSlug,
  type ExceptionEntry,
  type PublishedTermExams,
} from "@/extension/finalExamsParse";
import { parseDetachedDocument } from "@/extension/testing/detachedDocument";

// Raw server HTML of arr.usc.edu/final-exam-schedule/ (167,953 bytes,
// sha256 a80e34e4a14b06bd5ae5d9e75037e0b6e024863b439361a468a5f761a836a862, page modified 2026-10-27).
const FIXTURE = readFileSync(new URL("./fixtures/finalExamSchedule-2026-10-27.html", import.meta.url), "utf8");

async function parseTerm(html: string, termId: string) {
  return parseFinalExamSchedule(await parseDetachedDocument(html), termId);
}

async function published(html: string, termId: string): Promise<PublishedTermExams> {
  const result = await parseTerm(html, termId);
  if (!result.ok) {
    assert.fail(result.error);
  }
  return result.data;
}

function exceptionFor(data: PublishedTermExams, course: string): ExceptionEntry[] {
  return data.exceptions.filter((entry) => entry.courses.includes(course));
}

test("parses Fall 2026 from the live fixture", async () => {
  const fall = await published(FIXTURE, "20263");
  assert.equal(fall.finalsStart, "2026-12-09");
  assert.deepEqual(fall.unparsedExceptionNumbers, []);
  assert.equal(fall.finalsEnd, "2026-12-16");
  assert.equal(fall.exceptions.length, 29);
  assert.deepEqual(fall.unparsedRows, []);
  assert.equal(fall.grid.filter((rule) => rule.kind === "family").length, 14);
  // Fall has none of Spring's extra policy rows.
  assert.deepEqual(
    fall.grid.filter((rule) => rule.kind === "policy").map((rule) => rule.kind === "policy" && rule.policy),
    ["sameAsFamily", "sameAsFamily"],
  );
  // Corrected vs. the prototype: Saturday mornings are 10–12, and there's a Saturday afternoon row.
  const saturdays = fall.grid.filter((rule) => rule.kind === "saturday");
  assert.deepEqual(
    saturdays.map((rule) => rule.kind === "saturday" && [rule.half, rule.slot]),
    [
      ["morning", { date: "2026-12-12", start: "10:00", end: "12:00" }],
      ["afternoon", { date: "2026-12-12", start: "14:00", end: "16:00" }],
    ],
  );
});

test("parses Spring 2027, including the rows Fall doesn't have", async () => {
  const spring = await published(FIXTURE, "20271");
  assert.equal(spring.finalsStart, "2027-05-05");
  assert.equal(spring.finalsEnd, "2027-05-12");
  assert.equal(spring.exceptions.length, 31);
  assert.deepEqual(spring.unparsedRows, []);
  const policies = spring.grid.flatMap((rule) => (rule.kind === "policy" ? [rule.policy] : []));
  assert.deepEqual(policies, [
    "sameAsFamily",
    "sameAsFamily",
    "lectureAndLab",
    "labWithoutLecture",
    "irregularTime",
    "conflicts",
  ]);
});

test("keeps letter suffixes distinct (PHYS 135A vs 135B, BUAD 311 vs 311T)", async () => {
  const fall = await published(FIXTURE, "20263");
  assert.deepEqual(exceptionFor(fall, "PHYS 135B")[0]?.slot, { date: "2026-12-09", start: "14:00", end: "16:00" });
  assert.deepEqual(exceptionFor(fall, "PHYS 135A")[0]?.slot, { date: "2026-12-11", start: "08:00", end: "10:00" });
  assert.equal(exceptionFor(fall, "PHYS 135").length, 0);
  assert.equal(exceptionFor(fall, "BUAD 311T").length, 1);
  assert.equal(exceptionFor(fall, "BUAD 311").length, 1);
  assert.equal(exceptionFor(fall, "CHEM 105A").length, 1);
  assert.equal(exceptionFor(fall, "CHEM 105").length, 0);
});

test("splits semicolon rows and maps department names with parentheses", async () => {
  const spring = await published(FIXTURE, "20271");
  const row = spring.exceptions.find((entry) => entry.label.startsWith("French"));
  assert.deepEqual(row?.courses, ["FREN 120", "FREN 150", "FREN 220", "MPVA 261"]);
  assert.deepEqual(row?.slot, { date: "2027-05-08", start: "14:00", end: "16:00" });
  // MPVA 261 and EALC 215 really are listed twice at different times on the published page.
  assert.equal(exceptionFor(spring, "MPVA 261").length, 2);
  assert.equal(exceptionFor(spring, "EALC 215").length, 2);
  assert.deepEqual(parseExceptionCourses("Performance (Vocal Arts) 260, 261"), ["MPVA 260", "MPVA 261"]);
  assert.deepEqual(parseExceptionCourses("BUAD 427"), ["BUAD 427"]);
  assert.deepEqual(parseExceptionCourses("DSO 587"), ["DSO 587"]);
});

test("every department name on today's page is mapped", async () => {
  const doc = await parseDetachedDocument(FIXTURE);
  const exceptionTables = Array.from(doc.querySelectorAll("table")).filter((table) =>
    /Department and Course Number|^\s*COURSE\s*$/m.test(table.querySelector("th")?.textContent ?? ""),
  );
  assert.equal(exceptionTables.length, 2);
  const names = new Set<string>();
  for (const table of exceptionTables) {
    for (const cell of table.querySelectorAll("tbody tr td:first-child")) {
      for (const part of (cell.textContent ?? "").split(";")) {
        const name = part
          .replace(/\s+/g, " ")
          .trim()
          .match(/^(.+?)\s+\d/)?.[1];
        assert.ok(name, `unreadable cell "${part}"`);
        names.add(name.toLowerCase());
      }
    }
  }
  assert.deepEqual(
    [...names].filter((name) => !DEPARTMENT_CODES.has(name)),
    [],
  );
  assert.ok(names.has("performance (vocal arts)"));
  assert.equal(names.size, 16);
});

test("an unknown department is reported and skipped, never guessed", async () => {
  const html = FIXTURE.replace("Computer Science 585", "Underwater Basketweaving 585");
  const spring = await published(html, "20271");
  assert.equal(spring.exceptions.length, 30);
  assert.deepEqual(spring.unparsedRows, [
    "exception: Underwater Basketweaving 585 | Wednesday, May 5 | 8:00 – 10:00 AM",
  ]);
  // The unreadable row's course numbers are kept so the resolver won't hand those courses a grid time.
  assert.deepEqual(spring.unparsedExceptionNumbers, ["585"]);
});

test("accepts either exceptions header wording in either term", async () => {
  // Swap the wordings: Fall gets Spring's headers and Spring gets Fall's.
  const swapped = FIXTURE.replace(
    /Department and Course Number([\s\S]*?)Examination Day([\s\S]*?)Hour/,
    "COURSE$1DATE$2TIME",
  ).replace(/>COURSE<([\s\S]*?)>DATE<([\s\S]*?)>TIME</, ">Department and Course Number<$1>Examination Day<$2>Hour<");
  assert.notEqual(swapped, FIXTURE);
  assert.equal((await published(swapped, "20263")).exceptions.length, 29);
  assert.equal((await published(swapped, "20271")).exceptions.length, 31);
});

test("unrecognised headers fail loudly so the caller falls back and logs", async () => {
  const html = FIXTURE.replace(">COURSE<", ">COURSE CODE<");
  const result = await parseTerm(html, "20271");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /Unrecognised final exam table headers for spring-2027/);
  // Fall is untouched by that edit.
  assert.equal((await parseTerm(html, "20263")).ok, true);
});

test("terms without a chapter are not published", async () => {
  const result = await parseTerm(FIXTURE, "20273");
  assert.equal(result.ok, false);
  assert.equal(termSlug("20272"), null);
  assert.equal((await parseTerm(FIXTURE, "20272")).ok, false);
});

test("a date whose weekday doesn't match is rejected", () => {
  assert.equal(parseExamDate("Wednesday, December 9", 2026), "2026-12-09");
  assert.equal(parseExamDate("Thursday, December 9", 2026), null);
});

test("hour ranges infer the start meridiem", () => {
  assert.deepEqual(parseHourRange("8:00 – 10:00 AM"), { start: "08:00", end: "10:00" });
  assert.deepEqual(parseHourRange("11:00 AM – 1:00 PM"), { start: "11:00", end: "13:00" });
  assert.deepEqual(parseHourRange("10:00 AM – 12:00 PM"), { start: "10:00", end: "12:00" });
  assert.deepEqual(parseHourRange("2:00 – 4:00 PM"), { start: "14:00", end: "16:00" });
  assert.deepEqual(parseHourRange("12:00 – 2:00 PM"), { start: "12:00", end: "14:00" });
});

test("course keys normalise case and separators", () => {
  assert.equal(normalizeCourseKey("NAUT-301a"), "NAUT 301A");
  assert.equal(normalizeCourseKey("phys 135B"), "PHYS 135B");
  assert.equal(normalizeCourseKey("BUAD-311T"), "BUAD 311T");
  assert.equal(normalizeCourseKey("not a course"), null);
});

test("bundled fallback data equals parse(fixture) for both terms", async () => {
  for (const term of FINAL_EXAMS_FALLBACK) {
    assert.deepEqual(term, await published(FIXTURE, term.termId));
  }
  assert.deepEqual(
    FINAL_EXAMS_FALLBACK.map((term) => term.termId),
    ["20263", "20271"],
  );
});

test("a partly unreadable exceptions row reports every course number in it", async () => {
  const fall = await published(FIXTURE.replace("Accounting 416", "Accounting 416; Data Science 101"), "20263");
  assert.deepEqual(fall.unparsedExceptionNumbers, ["101", "416"]);
  assert.equal(
    fall.exceptions.some((entry) => entry.courses.includes("ACCT 416")),
    false,
  );
});
