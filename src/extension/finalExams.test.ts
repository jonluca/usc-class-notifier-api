import assert from "node:assert/strict";
import test from "node:test";
import type { RawMeeting } from "@/extension/courseBinDom";
import {
  describeUnresolved,
  formatExamSlot,
  resolveFinalExams,
  type ExamEntry,
  type ExamSectionInput,
  type ExamSectionState,
} from "@/extension/finalExams";
import { FINAL_EXAMS_FALLBACK } from "@/extension/finalExamsFallback";
import type { ExamSlot, PublishedTermExams } from "@/extension/finalExamsParse";

function termData(termId: string): PublishedTermExams {
  const data = FINAL_EXAMS_FALLBACK.find((term) => term.termId === termId);
  if (!data) {
    assert.fail(`no fallback for ${termId}`);
  }
  return data;
}
const FALL = termData("20263");
const SPRING = termData("20271");

let nextId = 10000;
function meeting(days: string, start: string, end: string): RawMeeting {
  return { days: days.split(" "), start, end };
}
function section(
  course: string,
  type: string,
  meetings: RawMeeting[],
  sessionId = "001",
  state: ExamSectionState = "registered",
): ExamSectionInput {
  nextId += 1;
  return { id: String(nextId), course, title: `${course} title`, type, sessionId, state, meetings };
}

function only(entries: ExamEntry[]): ExamEntry {
  assert.equal(entries.length, 1, JSON.stringify(entries, null, 2));
  return entries[0]!;
}
function slotOf(entry: ExamEntry): ExamSlot {
  const resolution = entry.resolution;
  if (resolution.kind !== "grid" && resolution.kind !== "exception") {
    assert.fail(`expected a time, got ${JSON.stringify(resolution)}`);
  }
  return resolution.slot;
}
function slot(date: string, start: string, end: string): ExamSlot {
  return { date, start, end };
}

test("MWF and subset-of-MWF classes use the MWF row", () => {
  const mwf = only(resolveFinalExams([section("HIST 240", "Lecture", [meeting("MO WE FR", "10:00", "10:50")])], FALL));
  assert.equal(mwf.resolution.kind, "grid");
  assert.deepEqual(slotOf(mwf), slot("2026-12-14", "08:00", "10:00"));
  const mw = only(resolveFinalExams([section("HIST 241", "Lecture", [meeting("MO WE", "10:00", "11:20")])], FALL));
  assert.deepEqual(slotOf(mw), slot("2026-12-14", "08:00", "10:00"));
});

test("the family comes from the first meeting day, not a subset check", () => {
  // Meets Mon/Tue/Wed: first meeting is Monday → MWF.
  const mtw = only(resolveFinalExams([section("MATH 225", "Lecture", [meeting("MO TU WE", "09:00", "09:50")])], FALL));
  assert.deepEqual(slotOf(mtw), slot("2026-12-14", "11:00", "13:00"));
  // Meets Tue/Fri: first meeting is Tuesday → TTh.
  const tf = only(resolveFinalExams([section("MATH 227", "Lecture", [meeting("TU FR", "09:00", "09:50")])], FALL));
  assert.deepEqual(slotOf(tf), slot("2026-12-10", "11:00", "13:00"));
});

test("TTh 10:00 starts are told apart by end time", () => {
  const short = only(resolveFinalExams([section("ECON 203", "Lecture", [meeting("TU TH", "10:00", "10:50")])], FALL));
  assert.deepEqual(slotOf(short), slot("2026-12-10", "11:00", "13:00"));
  const long = only(resolveFinalExams([section("ECON 205", "Lecture", [meeting("TU TH", "10:00", "11:50")])], FALL));
  assert.deepEqual(slotOf(long), slot("2026-12-15", "08:00", "10:00"));
  const other = only(resolveFinalExams([section("ECON 303", "Lecture", [meeting("TU TH", "10:00", "11:20")])], FALL));
  assert.equal(other.resolution.kind, "unresolved");
  assert.equal(other.resolution.kind === "unresolved" && other.resolution.reason, "irregularTime");
});

test("lecture + lab (and discussion/quiz) give one entry driven by the lecture", () => {
  const sections = [
    section("BISC 120", "Lab", [meeting("TH", "14:00", "16:50")]),
    section("BISC 121", "Lecture", [meeting("MO WE FR", "09:00", "09:50")]),
    section("BISC 121", "Lab", [meeting("TU", "14:00", "16:50")]),
    section("BISC 121", "Discussion", [meeting("FR", "13:00", "13:50")]),
    section("BISC 121", "Quiz", [meeting("WE", "19:00", "20:50")]),
  ];
  const entries = resolveFinalExams(sections, FALL);
  const bisc121 = entries.find((entry) => entry.course === "BISC 121");
  assert.ok(bisc121);
  assert.equal(entries.filter((entry) => entry.course === "BISC 121").length, 1);
  assert.equal(bisc121.sections.length, 4);
  assert.deepEqual(slotOf(bisc121), slot("2026-12-14", "11:00", "13:00"));
});

test("Lecture-Lab and Lecture-Discussion types drive the time", () => {
  const entry = only(
    resolveFinalExams(
      [
        section("CSCI 109", "Lecture-Lab", [meeting("TU TH", "12:30", "13:50")]),
        section("CSCI 109", "Lab", [meeting("FR", "08:00", "09:50")]),
      ],
      FALL,
    ),
  );
  assert.deepEqual(slotOf(entry), slot("2026-12-15", "11:00", "13:00"));
});

test("the first lecture of the week decides when a lecture has two patterns", () => {
  const entry = only(
    resolveFinalExams(
      [section("PHIL 100", "Lecture", [meeting("WE", "10:00", "10:50"), meeting("MO", "15:00", "15:50")])],
      FALL,
    ),
  );
  assert.deepEqual(slotOf(entry), slot("2026-12-14", "14:00", "16:00"));
});

test("two included lecture sections in different slots are listed separately", () => {
  const early = section("ECON 351", "Lecture", [meeting("MO WE", "08:00", "09:20")]);
  const late = section("ECON 351", "Lecture", [meeting("TU TH", "14:00", "15:20")], "001", "scheduled");
  const entries = resolveFinalExams([early, late], FALL);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => [entry.sections.map((s) => s.id), slotOf(entry)]),
    [
      [[early.id], slot("2026-12-09", "08:00", "10:00")],
      [[late.id], slot("2026-12-10", "14:00", "16:00")],
    ],
  );
  // Same slot → one entry listing both sections.
  const twin = section("ECON 351", "Lecture", [meeting("MO WE", "08:30", "09:50")]);
  assert.equal(resolveFinalExams([early, twin], FALL).length, 1);
});

test("4–6 PM starts and once-weekly evening classes use the first class period in finals week", () => {
  // Fall finals start Wed Dec 9: a TTh class's first period is Thu Dec 10.
  const fourPm = only(resolveFinalExams([section("WRIT 340", "Lecture", [meeting("TU TH", "16:00", "17:20")])], FALL));
  assert.deepEqual(slotOf(fourPm), slot("2026-12-10", "16:30", "18:30"));
  const fivePm = only(resolveFinalExams([section("WRIT 341", "Lecture", [meeting("MO", "17:00", "19:50")])], FALL));
  assert.deepEqual(slotOf(fivePm), slot("2026-12-14", "16:30", "18:30"));
  const wedNight = only(resolveFinalExams([section("CTPR 290", "Lecture", [meeting("WE", "18:00", "20:50")])], FALL));
  assert.deepEqual(slotOf(wedNight), slot("2026-12-09", "19:00", "21:00"));
  const monNight = only(resolveFinalExams([section("CTPR 291", "Lecture", [meeting("MO", "19:00", "21:50")])], FALL));
  assert.deepEqual(slotOf(monNight), slot("2026-12-14", "19:00", "21:00"));
});

test("6 and 8 PM MW/TTh pairs use their fixed dates; other twice-weekly evenings are unresolved", () => {
  const mw6 = only(resolveFinalExams([section("ITP 115", "Lecture", [meeting("MO WE", "18:00", "19:50")])], FALL));
  assert.deepEqual(slotOf(mw6), slot("2026-12-09", "19:00", "21:00"));
  const tth8 = only(resolveFinalExams([section("ITP 116", "Lecture", [meeting("TU TH", "20:00", "21:50")])], SPRING));
  assert.deepEqual(slotOf(tth8), slot("2027-05-11", "19:00", "21:00"));
  const mw630 = only(resolveFinalExams([section("ITP 117", "Lecture", [meeting("MO WE", "18:30", "19:50")])], FALL));
  assert.equal(mw630.resolution.kind === "unresolved" && mw630.resolution.reason, "irregularTime");
});

test("Saturday-only classes use the Saturday rows", () => {
  const morning = only(resolveFinalExams([section("ARLT 100", "Lecture", [meeting("SA", "09:00", "11:50")])], FALL));
  assert.deepEqual(slotOf(morning), slot("2026-12-12", "10:00", "12:00"));
  const afternoon = only(resolveFinalExams([section("ARLT 101", "Lecture", [meeting("SA", "13:00", "15:50")])], FALL));
  assert.deepEqual(slotOf(afternoon), slot("2026-12-12", "14:00", "16:00"));
});

test("sessions: 001 and 046 use the grid, 061 has no exam, others are unresolved", () => {
  const time = [meeting("MO WE FR", "11:00", "11:50")];
  assert.equal(only(resolveFinalExams([section("PSYC 100", "Lecture", time, "046")], FALL)).resolution.kind, "grid");
  assert.equal(only(resolveFinalExams([section("PSYC 101", "Lecture", time, "061")], FALL)).resolution.kind, "noExam");
  const den = only(resolveFinalExams([section("EE 450", "Lecture", time, "014")], FALL));
  assert.deepEqual(den.resolution, { kind: "unresolved", reason: "nonStandardSession", detail: "014", candidates: [] });
  assert.match(describeUnresolved(den.resolution), /Session 014 isn't a standard session/);
  const unknown = only(resolveFinalExams([{ ...section("PSYC 102", "Lecture", time), sessionId: undefined }], FALL));
  assert.equal(unknown.resolution.kind === "unresolved" && unknown.resolution.reason, "nonStandardSession");
});

test("exceptions beat the grid, keep suffixes exact, and normalise case", () => {
  const time = [meeting("MO WE FR", "10:00", "10:50")];
  const a = only(resolveFinalExams([section("PHYS 135A", "Lecture", time)], FALL));
  assert.equal(a.resolution.kind, "exception");
  assert.deepEqual(slotOf(a), slot("2026-12-11", "08:00", "10:00"));
  const b = only(resolveFinalExams([section("phys-135b", "Lecture", time)], FALL));
  assert.equal(b.course, "PHYS 135B");
  assert.deepEqual(slotOf(b), slot("2026-12-09", "14:00", "16:00"));
  // 311T is its own exception entry, not a prefix match on 311 (both happen to share a slot here).
  const t = only(resolveFinalExams([section("BUAD 311T", "Lecture", time)], FALL));
  assert.equal(t.resolution.kind, "exception");
  // A course that only shares a prefix with an exception falls through to the grid.
  const g = only(resolveFinalExams([section("PHYS 135", "Lecture", time)], FALL));
  assert.equal(g.resolution.kind, "grid");
  const naut = only(resolveFinalExams([section("NAUT-301a", "Lecture", time)], FALL));
  assert.equal(naut.course, "NAUT 301A");
});

test("exceptions apply outside standard sessions, except 061", () => {
  // CSCI 570 is only offered in sessions 048/034 for Spring 2027.
  const csci = only(
    resolveFinalExams([section("CSCI 570", "Lecture", [meeting("TU TH", "17:00", "18:50")], "048")], SPRING),
  );
  assert.equal(csci.resolution.kind, "exception");
  assert.deepEqual(slotOf(csci), slot("2027-05-10", "16:30", "18:30"));
  const noFinals = only(
    resolveFinalExams([section("CSCI 104", "Lecture", [meeting("MO WE", "10:00", "11:50")], "061")], SPRING),
  );
  assert.equal(noFinals.resolution.kind, "noExam");
});

test("a course listed at two different times is unresolved and shows both", () => {
  const entry = only(resolveFinalExams([section("MPVA 261", "Lecture", [meeting("TU TH", "10:00", "10:50")])], SPRING));
  assert.deepEqual(entry.resolution, {
    kind: "unresolved",
    reason: "conflictingExceptions",
    detail: "",
    candidates: [slot("2027-05-08", "11:00", "13:00"), slot("2027-05-08", "14:00", "16:00")],
  });
  assert.equal(
    describeUnresolved(entry.resolution),
    "The registrar lists this course at two different times (Sat, May 8, 11:00 AM – 1:00 PM or Sat, May 8, 2:00 PM – 4:00 PM). Check with your instructor.",
  );
  const ealc = only(
    resolveFinalExams([section("EALC 215", "Lecture", [meeting("MO WE FR", "09:00", "09:50")])], SPRING),
  );
  assert.equal(ealc.resolution.kind === "unresolved" && ealc.resolution.reason, "conflictingExceptions");
});

test("courses without a usable lecture are unresolved with a reason", () => {
  const lab = only(resolveFinalExams([section("BISC 105", "Lab", [meeting("TU", "09:00", "11:50")])], SPRING));
  assert.equal(lab.resolution.kind === "unresolved" && lab.resolution.reason, "labOnly");
  const disc = only(resolveFinalExams([section("WRIT 150", "Discussion", [meeting("MO WE", "10:00", "11:50")])], FALL));
  assert.equal(disc.resolution.kind === "unresolved" && disc.resolution.reason, "noLecture");
  const tba = only(resolveFinalExams([section("WRIT 151", "Lecture", [])], FALL));
  assert.equal(tba.resolution.kind === "unresolved" && tba.resolution.reason, "noMeetingTime");
  // A seminar-only course is still a class in a regular period.
  const seminar = only(resolveFinalExams([section("THTR 252", "Seminar", [meeting("MO WE", "12:00", "13:50")])], FALL));
  assert.deepEqual(slotOf(seminar), slot("2026-12-11", "11:00", "13:00"));
});

test("the resolver doesn't filter by registration state; that's the caller's job", () => {
  const entries = resolveFinalExams(
    [
      section("ARTS 101", "Lecture", [meeting("MO WE", "08:00", "09:50")], "001", "registered"),
      section("ARTS 102", "Lecture", [meeting("MO WE", "08:00", "09:50")], "001", "scheduled"),
      section("ARTS 103", "Lecture", [meeting("MO WE", "08:00", "09:50")], "001", "bin"),
    ],
    FALL,
  );
  assert.deepEqual(
    entries.map((entry) => [entry.course, entry.sections[0]?.state]),
    [
      ["ARTS 101", "registered"],
      ["ARTS 102", "scheduled"],
      ["ARTS 103", "bin"],
    ],
  );
});

test("slots format for display", () => {
  assert.equal(formatExamSlot(slot("2026-12-09", "08:00", "10:00")), "Wed, Dec 9, 8:00 AM – 10:00 AM");
  assert.equal(formatExamSlot(slot("2027-05-08", "12:00", "14:00")), "Sat, May 8, 12:00 PM – 2:00 PM");
});

// ---- Regressions found in independent review (2026-11-01) ----

test("a lecture split into two patterns at the same time merges its days (MW 6 PM is not once-weekly)", () => {
  const entry = only(
    resolveFinalExams(
      [section("HIST 300", "Lecture", [meeting("MO", "18:00", "20:50"), meeting("WE", "18:00", "20:50")])],
      FALL,
    ),
  );
  assert.deepEqual(slotOf(entry), slot("2026-12-09", "19:00", "21:00"));
});

test("patterns with the same start but different end times still merge their days", () => {
  const entry = only(
    resolveFinalExams(
      [section("HIST 300", "Lecture", [meeting("MO", "18:00", "20:50"), meeting("WE", "18:00", "19:20")])],
      FALL,
    ),
  );
  // Different end times → not the same pattern; both start after 6 PM → nothing safe to pick.
  assert.equal(entry.resolution.kind === "unresolved" && entry.resolution.reason, "irregularTime");
});

test("'first scheduled class period' considers every pattern's days", () => {
  const entry = only(
    resolveFinalExams(
      [section("HIST 301", "Lecture", [meeting("MO", "16:00", "17:50"), meeting("TH", "16:00", "17:20")])],
      FALL,
    ),
  );
  // Fall finals start Wed Dec 9; the first Mon/Thu class period is Thu Dec 10.
  assert.deepEqual(slotOf(entry), slot("2026-12-10", "16:30", "18:30"));
});

test("daytime lecture with patterns at different times uses the first lecture of the week", () => {
  const entry = only(
    resolveFinalExams(
      [section("PHIL 101", "Lecture", [meeting("WE", "14:00", "15:50"), meeting("MO", "10:00", "10:50")])],
      FALL,
    ),
  );
  assert.deepEqual(slotOf(entry), slot("2026-12-14", "08:00", "10:00"));
});

test("an exception course with one 061 lecture and one 001 lecture lists both", () => {
  const regular = section("CSCI 360", "Lecture", [meeting("MO WE", "10:00", "11:50")], "001");
  const noFinals = section("CSCI 360", "Lecture", [meeting("TU TH", "10:00", "11:50")], "061");
  const entries = resolveFinalExams([regular, noFinals], FALL);
  assert.deepEqual(
    entries.map((entry) => [entry.sections.map((s) => s.id), entry.resolution.kind]),
    [
      [[regular.id], "exception"],
      [[noFinals.id], "noExam"],
    ],
  );
});

test("a course number named in an unreadable exceptions row never falls through to the grid", () => {
  const data: PublishedTermExams = {
    ...FALL,
    exceptions: FALL.exceptions.filter((entry) => !entry.courses.includes("ACCT 416")),
    unparsedExceptionNumbers: ["101", "416"],
  };
  const entry = only(
    resolveFinalExams([section("ACCT 416", "Lecture", [meeting("MO WE FR", "10:00", "10:50")])], data),
  );
  assert.deepEqual(entry.resolution, {
    kind: "unresolved",
    reason: "unreadableException",
    detail: "416",
    candidates: [],
  });
  assert.match(describeUnresolved(entry.resolution), /couldn't read/);
});

test("a Saturday class starting at 6 PM or later isn't a 'Saturday afternoon' class", () => {
  const evening = only(resolveFinalExams([section("ARLT 102", "Lecture", [meeting("SA", "18:00", "20:50")])], FALL));
  assert.equal(evening.resolution.kind === "unresolved" && evening.resolution.reason, "irregularTime");
  const noon = only(resolveFinalExams([section("ARLT 103", "Lecture", [meeting("SA", "12:00", "14:50")])], FALL));
  assert.deepEqual(slotOf(noon), slot("2026-12-12", "14:00", "16:00"));
});
