import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scrapeCourseBinSections, scrapeRegisteredSections } from "@/extension/courseBinDom";
import { formatExamSlot, resolveFinalExams, type ExamEntry } from "@/extension/finalExams";
import { FINAL_EXAMS_FALLBACK } from "@/extension/finalExamsFallback";
import { parseDetachedDocument } from "@/extension/testing/detachedDocument";

// Real Spring 2027 /CourseBin capture (2026-11-01), trimmed to the status line, term tab, button holder
// and course panels. Anonymized for a public repo: the student's name, email and anti-forgery token are
// removed, section numbers are replaced with 10001–10017 and instructor names with "Instructor, A"–"E".
// Courses, meeting times, sessions and registration states are as captured.
const COURSE_BIN = readFileSync(new URL("./fixtures/courseBin-20271-2026-11-01.html", import.meta.url), "utf8");
const SPRING = FINAL_EXAMS_FALLBACK.find((term) => term.termId === "20271")!;

function summary(entries: ExamEntry[]): string[] {
  return entries.map((entry) => {
    const resolution = entry.resolution;
    const result =
      resolution.kind === "grid" || resolution.kind === "exception"
        ? `${resolution.kind} ${formatExamSlot(resolution.slot)}`
        : resolution.kind;
    return `${entry.course} [${entry.sections.map((section) => section.id).join(",")}] ${result}`;
  });
}

test("real CourseBin: every section is scraped with its state and session", async () => {
  const sections = scrapeCourseBinSections(await parseDetachedDocument(COURSE_BIN));
  assert.equal(sections.length, 17);
  assert.equal(sections.filter((section) => section.state === "scheduled").length, 10);
  assert.equal(sections.filter((section) => section.state === "bin").length, 7);
  assert.ok(sections.every((section) => section.sessionId === "001"));
  // WebReg prints "NAUT-301A"; the key is normalised with its suffix intact.
  assert.ok(sections.some((section) => section.course === "NAUT 301A"));
});

test("real CourseBin: a TBA section with an empty Days cell has no meetings instead of aborting", async () => {
  const doc = await parseDetachedDocument(COURSE_BIN);
  const quiz = scrapeCourseBinSections(doc).find((section) => section.id === "10005");
  assert.equal(quiz?.type, "Quiz");
  assert.deepEqual(quiz?.meetings, []);
  // The calendar export shares this parser; nothing is registered in this capture.
  assert.deepEqual(scrapeRegisteredSections(doc), []);
});

test("real CourseBin: registered + scheduled sections resolve against Spring 2027", async () => {
  const sections = scrapeCourseBinSections(await parseDetachedDocument(COURSE_BIN));
  const included = sections.filter((section) => section.state !== "bin");
  assert.deepEqual(summary(resolveFinalExams(included, SPRING)), [
    "CSCI 201 [10004,10005,10006] exception Tue, May 11, 4:30 PM – 6:30 PM",
    "CSCI 270 [10007,10008,10009] exception Wed, May 12, 7:00 PM – 9:00 PM",
    "EE 109 [10010,10011] exception Sat, May 8, 2:00 PM – 4:00 PM",
    "MATH 407 [10015] grid Wed, May 5, 2:00 PM – 4:00 PM",
    "NAUT 301A [10017] grid Tue, May 11, 7:00 PM – 9:00 PM",
  ]);
  // Bin-only sections are left out by the caller, not the resolver (future "show all" toggle).
  assert.deepEqual(
    summary(
      resolveFinalExams(
        sections.filter((section) => section.state === "bin"),
        SPRING,
      ),
    ),
    [
      "CSCI 201 [10001,10002,10003] exception Tue, May 11, 4:30 PM – 6:30 PM",
      "MATH 407 [10012,10013,10014] grid Mon, May 10, 8:00 AM – 10:00 AM",
      "NAUT 301A [10016] grid Wed, May 5, 7:00 PM – 9:00 PM",
    ],
  );
});

test("real CourseBin: a truncated page is rejected instead of yielding a partial exam list", async () => {
  // Cut the capture partway through: WebReg still says 10 scheduled sections, fewer are parsed.
  const truncated = COURSE_BIN.slice(0, Math.floor(COURSE_BIN.length * 0.45));
  const doc = await parseDetachedDocument(truncated);
  assert.throws(() => scrapeCourseBinSections(doc), /WebReg reported 10 scheduled sections, but \d+ were parsed/);
});
