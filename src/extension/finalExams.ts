// Tentative final-exam resolver: a pure function from a list of sections plus one term's parsed
// registrar data to one entry per course. There's no DOM or storage here, and it filters nothing by
// registration state. The caller decides which sections to pass in (registered + scheduled in v1),
// so a later "show every CourseBin course" toggle only needs a UI change.
//
// Rules, in order:
// 1. Department exceptions (the registrar names the course explicitly) win over the grid and apply in
//    any session except 061, which has no finals week. A course listed in two exception rows with
//    different times is Unresolved, showing both listed times.
// 2. Otherwise one exam per course, driven by its lecture section(s). Labs, discussions and quizzes
//    never drive the time ("courses with both lecture and laboratory → first lecture of the week").
// 3. The grid applies only to standard sessions 001 (UPC) and 046 (HSC). The Session Codes page says
//    every other session is department-assigned, so those sections are Unresolved.
// 4. Grid family comes from the class's first meeting day of the week (M/W/F → MWF, T/Th → TTh),
//    then an exact start time, or an exact start–end for the TTh 10:00–10:50 / 10:00–11:50 rows.
//    Classes starting 4:00–5:59 PM, and once-weekly classes at 6 PM or later, take their "first
//    scheduled class period" inside the finals window.
// Anything else is Unresolved with a reason. This module never guesses a time.

import type { RawMeeting } from "@/extension/courseBinDom";
import {
  normalizeCourseKey,
  type DayFamily,
  type ExamSlot,
  type GridRule,
  type PublishedTermExams,
} from "@/extension/finalExamsParse";
import { firstOccurrenceOnOrAfter } from "@/extension/ics";

export type ExamSectionState = "registered" | "scheduled" | "bin";

export interface ExamSectionInput {
  id: string;
  course: string;
  title: string;
  type: string;
  sessionId?: string;
  state: ExamSectionState;
  meetings: RawMeeting[];
}

export type UnresolvedReason =
  | "conflictingExceptions"
  | "nonStandardSession"
  | "noLecture"
  | "labOnly"
  | "noMeetingTime"
  | "irregularTime"
  | "invalidCourse"
  | "unreadableException";

export type ExamResolution =
  | { kind: "exception"; slot: ExamSlot; label: string }
  | { kind: "grid"; slot: ExamSlot; rule: string }
  | { kind: "noExam" }
  | { kind: "unresolved"; reason: UnresolvedReason; detail: string; candidates: ExamSlot[] };

export interface ExamEntrySection {
  id: string;
  type: string;
  state: ExamSectionState;
  sessionId?: string;
}

export interface ExamEntry {
  course: string;
  title: string;
  sections: ExamEntrySection[];
  resolution: ExamResolution;
}

export const STANDARD_SESSIONS = new Set(["001", "046"]);
export const NO_FINALS_SESSION = "061";

const WEEK_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const MWF_DAYS = new Set(["MO", "WE", "FR"]);
const TTH_DAYS = new Set(["TU", "TH"]);
const NON_LECTURE_TYPES = new Set(["lab", "laboratory", "discussion", "quiz"]);

function weekIndex(day: string): number {
  const index = WEEK_ORDER.indexOf(day);
  return index < 0 ? WEEK_ORDER.length : index;
}

function sortedDays(days: string[]): string[] {
  return [...new Set(days)].sort((a, b) => weekIndex(a) - weekIndex(b));
}

function sameSlot(a: ExamSlot, b: ExamSlot): boolean {
  return a.date === b.date && a.start === b.start && a.end === b.end;
}

function uniqueSlots(slots: ExamSlot[]): ExamSlot[] {
  const result: ExamSlot[] = [];
  for (const slot of slots) {
    if (!result.some((existing) => sameSlot(existing, slot))) {
      result.push(slot);
    }
  }
  return result.sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
}

function unresolved(reason: UnresolvedReason, detail: string, candidates: ExamSlot[] = []): ExamResolution {
  return { kind: "unresolved", reason, detail, candidates };
}

function sameResolution(a: ExamResolution, b: ExamResolution): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if ((a.kind === "grid" || a.kind === "exception") && (b.kind === "grid" || b.kind === "exception")) {
    return sameSlot(a.slot, b.slot);
  }
  if (a.kind === "unresolved" && b.kind === "unresolved") {
    return a.reason === b.reason && a.detail === b.detail;
  }
  return true;
}

function isLectureType(type: string): boolean {
  return /^lecture\b/i.test(type.trim());
}

function isLabType(type: string): boolean {
  return /^lab(oratory)?$/i.test(type.trim());
}

// The sections whose meeting time decides the exam. Lecture types first ("Lecture", "Lecture-Lab",
// "Lecture-Discussion"). If the course has none, any section that isn't a lab, discussion or quiz
// counts (e.g. a seminar-only course is still a class meeting in a regular period).
function primarySections(sections: ExamSectionInput[]): ExamSectionInput[] {
  const lectures = sections.filter((section) => isLectureType(section.type));
  if (lectures.length > 0) {
    return lectures;
  }
  return sections.filter((section) => !NON_LECTURE_TYPES.has(section.type.trim().toLowerCase()));
}

interface TimedMeeting {
  days: string[];
  start: string;
  end: string;
}

function timedPatterns(meetings: RawMeeting[]): TimedMeeting[] {
  const timed: TimedMeeting[] = [];
  for (const meeting of meetings) {
    if (meeting.days.length > 0 && meeting.start && meeting.end) {
      timed.push({ days: sortedDays(meeting.days), start: meeting.start, end: meeting.end });
    }
  }
  return timed.sort((a, b) => weekIndex(a.days[0]!) - weekIndex(b.days[0]!) || a.start.localeCompare(b.start));
}

// Resolves a lecture that may be printed as several meeting patterns (e.g. "MO 6:00–8:50 PM" and
// "WE 6:00–7:20 PM"). Patterns sharing a start/end time are one class meeting on all their days, so
// their days are merged before matching: otherwise a MW evening class split in two would look
// "once weekly", and a "first scheduled class period" would ignore the other pattern's days.
// When the patterns start at different times, the registrar's "first lecture of the week" rule picks
// the earliest pattern for daytime classes; for afternoon/evening starts the only safe case is every
// pattern starting 4:00–5:59 PM (one shared "first scheduled class period" rule), else Unresolved.
function resolvePatterns(meetings: RawMeeting[], data: PublishedTermExams): ExamResolution {
  const timed = timedPatterns(meetings);
  const first = timed[0];
  if (!first) {
    return unresolved("noMeetingTime", "");
  }
  const allDays = sortedDays(timed.flatMap((pattern) => pattern.days));
  if (timed.every((pattern) => pattern.start === first.start && pattern.end === first.end)) {
    return matchGrid({ days: allDays, start: first.start, end: first.end }, data);
  }
  if (first.start < "16:00") {
    return matchGrid(first, data);
  }
  if (timed.every((pattern) => pattern.start >= "16:00" && pattern.start < "18:00")) {
    return matchGrid({ days: allDays, start: first.start, end: first.end }, data);
  }
  return unresolved("irregularTime", timed.map(describeMeeting).join(", "));
}

function familyOf(firstDay: string): DayFamily | null {
  if (MWF_DAYS.has(firstDay)) {
    return "MWF";
  }
  return TTH_DAYS.has(firstDay) ? "TTh" : null;
}

function describeMeeting(meeting: TimedMeeting): string {
  return `${meeting.days.join("")} ${meeting.start}–${meeting.end}`;
}

function firstMeetingSlot(
  meeting: TimedMeeting,
  data: PublishedTermExams,
  start: string,
  end: string,
): ExamSlot | null {
  const date = firstOccurrenceOnOrAfter(data.finalsStart, meeting.days);
  return date <= data.finalsEnd ? { date, start, end } : null;
}

export function matchGrid(meeting: TimedMeeting, data: PublishedTermExams): ExamResolution {
  const grid: GridRule[] = data.grid;
  const days = meeting.days;
  const weekdays = days.filter((day) => day !== "SA" && day !== "SU");
  const irregular = unresolved("irregularTime", describeMeeting(meeting));

  if (days.length === 1 && days[0] === "SA") {
    // A Saturday class starting at 6 PM or later is an evening class, not "Saturday afternoons only".
    if (meeting.start >= "18:00") {
      return irregular;
    }
    const half = meeting.start < "12:00" ? "morning" : "afternoon";
    const rule = grid.find((candidate) => candidate.kind === "saturday" && candidate.half === half);
    return rule && rule.kind === "saturday" ? { kind: "grid", slot: rule.slot, rule: rule.label } : irregular;
  }
  if (weekdays.length !== days.length || weekdays.length === 0) {
    return irregular;
  }

  if (meeting.start >= "16:00") {
    const pair = grid.find(
      (rule) =>
        rule.kind === "eveningPair" &&
        rule.start === meeting.start &&
        rule.days.length === days.length &&
        rule.days.every((day) => days.includes(day)),
    );
    if (pair && pair.kind === "eveningPair") {
      return { kind: "grid", slot: pair.slot, rule: pair.label };
    }
    for (const rule of grid) {
      if (rule.kind !== "firstMeeting") {
        continue;
      }
      if (meeting.start < rule.minStart || (rule.maxStartExclusive && meeting.start >= rule.maxStartExclusive)) {
        continue;
      }
      if (rule.onceWeekly && days.length !== 1) {
        continue;
      }
      const slot = firstMeetingSlot(meeting, data, rule.examTime.start, rule.examTime.end);
      return slot ? { kind: "grid", slot, rule: rule.label } : irregular;
    }
    return irregular;
  }

  const family = familyOf(days[0]!);
  if (!family) {
    return irregular;
  }
  const familyRules = grid.filter((rule) => rule.kind === "family" && rule.family === family);
  const exact = familyRules.filter(
    (rule) =>
      rule.kind === "family" &&
      rule.exactRanges.some((range) => range.start === meeting.start && range.end === meeting.end),
  );
  const byStart = familyRules.filter((rule) => rule.kind === "family" && rule.startTimes.includes(meeting.start));
  const matches = exact.length > 0 ? exact : byStart;
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only && only.kind === "family") {
    return { kind: "grid", slot: only.slot, rule: only.label };
  }
  return irregular;
}

function resolveSection(section: ExamSectionInput, data: PublishedTermExams): ExamResolution {
  if (section.sessionId === NO_FINALS_SESSION) {
    return { kind: "noExam" };
  }
  if (!section.sessionId || !STANDARD_SESSIONS.has(section.sessionId)) {
    return unresolved("nonStandardSession", section.sessionId ?? "unknown");
  }
  return resolvePatterns(section.meetings, data);
}

function entrySections(sections: ExamSectionInput[]): ExamEntrySection[] {
  return sections.map((section) => ({
    id: section.id,
    type: section.type,
    state: section.state,
    sessionId: section.sessionId,
  }));
}

function resolveCourse(course: string, sections: ExamSectionInput[], data: PublishedTermExams): ExamEntry[] {
  const title = sections.find((section) => section.title)?.title ?? "";
  const all = entrySections(sections);
  const single = (resolution: ExamResolution): ExamEntry[] => [{ course, title, sections: all, resolution }];

  const exceptionSlots = uniqueSlots(
    data.exceptions.filter((entry) => entry.courses.includes(course)).map((entry) => entry.slot),
  );
  const exceptionLabel = data.exceptions.find((entry) => entry.courses.includes(course))?.label ?? "";
  const primaries = primarySections(sections);
  const deciding = primaries.length > 0 ? primaries : sections;
  const courseNumber = course.split(" ")[1] ?? "";

  let results: { section: ExamSectionInput; resolution: ExamResolution }[];
  if (exceptionSlots.length > 0) {
    // The registrar names this course: its exception applies in every session except 061, decided per
    // lecture section so a 061 section next to a 001 one is listed separately rather than given an exam.
    const exceptionResolution: ExamResolution =
      exceptionSlots.length > 1
        ? unresolved("conflictingExceptions", "", exceptionSlots)
        : { kind: "exception", slot: exceptionSlots[0]!, label: exceptionLabel };
    results = deciding.map((section) => ({
      section,
      resolution: section.sessionId === NO_FINALS_SESSION ? { kind: "noExam" } : exceptionResolution,
    }));
  } else if (data.unparsedExceptionNumbers.includes(courseNumber)) {
    // An exceptions row we couldn't read mentions this course number. It may be this course, so the
    // grid time could be wrong: don't show one.
    results = deciding.map((section) => ({
      section,
      resolution:
        section.sessionId === NO_FINALS_SESSION ? { kind: "noExam" } : unresolved("unreadableException", courseNumber),
    }));
  } else if (primaries.length === 0) {
    return single(
      sections.some((section) => isLabType(section.type)) ? unresolved("labOnly", "") : unresolved("noLecture", ""),
    );
  } else {
    results = primaries.map((section) => ({ section, resolution: resolveSection(section, data) }));
  }

  const first = results[0]!.resolution;
  if (results.every((result) => sameResolution(result.resolution, first))) {
    return single(first);
  }
  // Two included lecture sections of one course land in different places: list each one with its
  // section number rather than picking.
  return results.map((result) => ({
    course,
    title,
    sections: entrySections([result.section]),
    resolution: result.resolution,
  }));
}

export function resolveFinalExams(sections: ExamSectionInput[], data: PublishedTermExams): ExamEntry[] {
  const byCourse = new Map<string, ExamSectionInput[]>();
  const invalid: ExamEntry[] = [];
  for (const section of sections) {
    const key = normalizeCourseKey(section.course);
    if (!key) {
      invalid.push({
        course: section.course,
        title: section.title,
        sections: entrySections([section]),
        resolution: unresolved("invalidCourse", section.course),
      });
      continue;
    }
    const group = byCourse.get(key) ?? [];
    group.push(section);
    byCourse.set(key, group);
  }

  const entries = [...byCourse].flatMap(([course, group]) => resolveCourse(course, group, data));
  return [...entries, ...invalid];
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatClock(time: string): string {
  const [hourText = "0", minute = "00"] = time.split(":");
  const hour = Number(hourText);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}

export function formatExamSlot(slot: ExamSlot): string {
  const date = new Date(`${slot.date}T00:00:00Z`);
  return `${DAY_NAMES[date.getUTCDay()]}, ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}, ${formatClock(
    slot.start,
  )} – ${formatClock(slot.end)}`;
}

// Human-readable explanation for an Unresolved entry. Every message ends with the same instruction.
export function describeUnresolved(resolution: ExamResolution): string {
  if (resolution.kind !== "unresolved") {
    return "";
  }
  const suffix = "Check with your instructor.";
  switch (resolution.reason) {
    case "conflictingExceptions":
      return `The registrar lists this course at two different times (${resolution.candidates
        .map(formatExamSlot)
        .join(" or ")}). ${suffix}`;
    case "nonStandardSession":
      return `Session ${resolution.detail} isn't a standard session, so the university exam grid doesn't apply. ${suffix}`;
    case "noLecture":
      return `No lecture section to base the exam time on. ${suffix}`;
    case "labOnly":
      return `Lab-only courses take their exam in the last regular class period, which this tool doesn't compute. ${suffix}`;
    case "noMeetingTime":
      return `The lecture has no scheduled meeting time. ${suffix}`;
    case "irregularTime":
      return `${resolution.detail} isn't one of the registrar's regular time periods. ${suffix}`;
    case "unreadableException":
      return `The registrar's exceptions list has a row mentioning course number ${resolution.detail} that this tool couldn't read. ${suffix}`;
    case "invalidCourse":
      return `Couldn't read the course code "${resolution.detail}". ${suffix}`;
  }
}
