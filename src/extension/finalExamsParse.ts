// Parser for arr.usc.edu/final-exam-schedule/. Document in, per-term exam data out. It has no
// fetch, chrome.* or jQuery, so it runs under node:test against the saved raw fixture, and the
// generated fallback data is produced by this same code (see tools/generateFinalExamsFallback.ts).
//
// Page structure as of the 2026-10-27 revision (src/extension/fixtures/finalExamSchedule-2026-10-27.html):
// - Each term is a chapter introduced by `span.chaptered-nav-anchor#fall-2026` / `#spring-2027`.
//   The chapter's first table is the start-time grid and its second is the department exceptions table.
// - Table ids (`tablepress-41`, `tablepress-44`) are CMS ids that are identical across terms, so tables
//   are located by position within the chapter and then confirmed by header text.
// - Header wording differs between terms ("Department and Course Number / Examination Day / Hour"
//   for Fall and "COURSE / DATE / TIME" for Spring). Both are accepted. Anything else is a parse
//   failure, so the caller falls back to bundled data and logs the error instead of returning nothing.
//
// Never guess: an unrecognised grid row or department name is recorded in `unparsedRows` and skipped.
// Classes an unreadable grid row would have covered match no rule and resolve to "Unresolved"; for an
// unreadable exceptions row, its course numbers are kept in `unparsedExceptionNumbers` so the resolver
// shows those courses as Unresolved instead of falling through to a possibly wrong grid time.

export const FINAL_EXAM_SCHEDULE_URL = "https://arr.usc.edu/final-exam-schedule/";

export interface ExamSlot {
  date: string; // YYYY-MM-DD
  start: string; // HH:MM, 24h
  end: string;
}

export interface TimeRange {
  start: string;
  end: string;
}

export type DayFamily = "MWF" | "TTh";

export interface FamilyGridRule {
  kind: "family";
  label: string;
  family: DayFamily;
  startTimes: string[];
  exactRanges: TimeRange[];
  slot: ExamSlot;
}

export interface EveningPairGridRule {
  kind: "eveningPair";
  label: string;
  days: string[]; // exactly ["MO","WE"] or ["TU","TH"]
  start: string;
  slot: ExamSlot;
}

export interface FirstMeetingGridRule {
  kind: "firstMeeting";
  label: string;
  minStart: string;
  maxStartExclusive: string | null;
  onceWeekly: boolean;
  examTime: TimeRange;
}

export interface SaturdayGridRule {
  kind: "saturday";
  label: string;
  half: "morning" | "afternoon";
  slot: ExamSlot;
}

export type GridPolicy = "sameAsFamily" | "lectureAndLab" | "labWithoutLecture" | "irregularTime" | "conflicts";

export interface PolicyGridRule {
  kind: "policy";
  label: string;
  policy: GridPolicy;
}

export type GridRule = FamilyGridRule | EveningPairGridRule | FirstMeetingGridRule | SaturdayGridRule | PolicyGridRule;

export interface ExceptionEntry {
  label: string; // the registrar's cell text, for display and debugging
  courses: string[]; // normalised course keys, e.g. "PHYS 135A", "BUAD 311T"
  slot: ExamSlot;
}

export interface PublishedTermExams {
  termId: string;
  finalsStart: string;
  finalsEnd: string;
  grid: GridRule[];
  exceptions: ExceptionEntry[];
  unparsedRows: string[];
  // Course numbers (e.g. "416", "135B") found in exceptions rows that couldn't be parsed. A course with
  // one of these numbers gets Unresolved instead of a grid time, since the unreadable row may cover it.
  unparsedExceptionNumbers: string[];
}

export type FinalExamsParseResult = { ok: true; data: PublishedTermExams } | { ok: false; error: string };

// Registrar department names → WebReg course prefixes. Every entry was checked on 2026-11-01 against
// classes.usc.edu's /api/Courses/Course for each course the 2026-10-27 page lists under it (135 of 140
// (term, course) pairs exist; the other five, BUAD 311T, MATH 127, and Spring MPVA 260/261, are simply
// not offered this year). "Performance (Vocal Arts)" is MPVA, the Thornton Vocal Arts prefix (Class Voice,
// USC Opera, Italian Language and Diction).
export const DEPARTMENT_CODES = new Map<string, string>([
  ["accounting", "ACCT"],
  ["biological sciences", "BISC"],
  ["business administration", "BUAD"],
  ["chemistry", "CHEM"],
  ["computer science", "CSCI"],
  ["east asian languages and cultures", "EALC"],
  ["electrical engineering", "EE"],
  ["french", "FREN"],
  ["german", "GERM"],
  ["italian", "ITAL"],
  ["mathematics", "MATH"],
  ["performance (vocal arts)", "MPVA"],
  ["physics", "PHYS"],
  ["spanish", "SPAN"],
  // Printed as bare codes on the page.
  ["buad", "BUAD"],
  ["dso", "DSO"],
]);

const MONTHS = new Map<string, number>(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((name, index) => [name, index + 1]),
);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const GRID_HEADERS = new Set(["class start time | examination day | hour"]);
const EXCEPTION_HEADERS = new Set(["department and course number | examination day | hour", "course | date | time"]);

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// "PHYS-135b", "phys 135B", "NAUT-301A" → "PHYS 135B". Returns null for anything that isn't a
// prefix plus a 1–4 digit number with an optional letter suffix.
export function normalizeCourseKey(value: string): string | null {
  const match = clean(value).match(/^([A-Za-z]{2,10})[\s-]+(\d{1,4})([A-Za-z]{0,3})$/);
  if (!match) {
    return null;
  }
  return `${match[1]!.toUpperCase()} ${match[2]}${match[3]!.toUpperCase()}`;
}

export function termSlug(termId: string): string | null {
  const match = termId.match(/^(\d{4})([13])$/);
  if (!match) {
    return null; // Summer has no university final-exam schedule.
  }
  return `${match[2] === "1" ? "spring" : "fall"}-${match[1]}`;
}

function to24Hour(hour12: number, meridiem: string): number {
  return (hour12 % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
}

function clock(hour12: number, minute: number, meridiem: string): string | null {
  if (hour12 < 1 || hour12 > 12 || minute > 59) {
    return null;
  }
  return `${pad2(to24Hour(hour12, meridiem))}:${pad2(minute)}`;
}

// "8:00 – 10:00 AM", "11:00 AM – 1:00 PM", "10:00 AM – 12:00 PM". When the start has no meridiem it
// inherits the end's; if that would put the start after the end it is the other half of the day.
export function parseHourRange(text: string): TimeRange | null {
  const match = clean(text).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[–—-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) {
    return null;
  }
  const end = clock(Number(match[4]), Number(match[5]), match[6]!);
  let start = clock(Number(match[1]), Number(match[2]), match[3] ?? match[6]!);
  if (!start || !end) {
    return null;
  }
  if (!match[3] && start >= end) {
    start = clock(Number(match[1]), Number(match[2]), match[6]!.toLowerCase() === "pm" ? "am" : "pm");
  }
  return start && start < end ? { start, end } : null;
}

// "Wednesday, December 9" → ISO date in the term's calendar year. The weekday name is checked
// against the computed date: a mismatch means the page or our year assumption is wrong.
export function parseExamDate(text: string, year: number): string | null {
  const match = clean(text).match(/^([A-Za-z]+),\s*([A-Za-z]+)\s+(\d{1,2})$/);
  if (!match) {
    return null;
  }
  const weekday = WEEKDAYS.indexOf(match[1]!.toLowerCase());
  const month = MONTHS.get(match[2]!.toLowerCase());
  const day = Number(match[3]);
  if (weekday < 0 || !month) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCDay() !== weekday) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseSlot(dayText: string, hourText: string, year: number): ExamSlot | null {
  const date = parseExamDate(dayText, year);
  const time = parseHourRange(hourText);
  return date && time ? { date, ...time } : null;
}

const FAMILY_ROW = /^(.+?)\s+(AM|PM)\s+(MWF|TTh)$/i;
const EVENING_PAIR_ROW = /^(\d{1,2}):(\d{2})\s*(PM)\s+(MW|TTh)$/i;
const FIRST_MEETING_TEXT = /^(.+?)\s+first scheduled class period\b/i;

function parseFamilyTokens(
  tokensText: string,
  meridiem: string,
): { startTimes: string[]; exactRanges: TimeRange[] } | null {
  const startTimes: string[] = [];
  const exactRanges: TimeRange[] = [];
  for (const token of tokensText.split(/\s+or\s+/i)) {
    const range = token.match(/^(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})$/);
    if (range) {
      const start = clock(Number(range[1]), Number(range[2]), meridiem);
      const end = clock(Number(range[3]), Number(range[4]), meridiem);
      if (!start || !end || start >= end) {
        return null;
      }
      exactRanges.push({ start, end });
      continue;
    }
    const single = token.match(/^(\d{1,2}):(\d{2})$/);
    if (!single) {
      return null;
    }
    const start = clock(Number(single[1]), Number(single[2]), meridiem);
    if (!start) {
      return null;
    }
    startTimes.push(start);
  }
  return { startTimes, exactRanges };
}

// One grid row (three cells) → a rule, or null when the wording isn't one we understand.
export function parseGridRow(cells: string[], year: number): GridRule | null {
  const [label = "", dayText = "", hourText = ""] = cells.map(clean);

  if (/^Classes with first meeting on (M or W or F|T or Th)$/i.test(label)) {
    return { kind: "policy", label, policy: "sameAsFamily" };
  }
  if (/^Courses with both lecture and laboratory$/i.test(label)) {
    return { kind: "policy", label, policy: "lectureAndLab" };
  }
  if (/^Laboratory courses without scheduled lecture\b/i.test(label)) {
    return { kind: "policy", label, policy: "labWithoutLecture" };
  }
  if (/^Classes not scheduled to meet in one of the regular time periods$/i.test(label)) {
    return { kind: "policy", label, policy: "irregularTime" };
  }
  if (/^Students with conflicting final examinations$/i.test(label)) {
    return { kind: "policy", label, policy: "conflicts" };
  }

  const saturday = label.match(/^Saturday (mornings|afternoons) only$/i);
  if (saturday) {
    const slot = parseSlot(dayText, hourText, year);
    return slot
      ? { kind: "saturday", label, half: saturday[1]!.toLowerCase() === "mornings" ? "morning" : "afternoon", slot }
      : null;
  }

  if (/^4:00 PM or starting after 4:00 PM but before 6:00 PM$/i.test(label)) {
    const time = parseHourRange(dayText.match(FIRST_MEETING_TEXT)?.[1] ?? "");
    return time
      ? {
          kind: "firstMeeting",
          label,
          minStart: "16:00",
          maxStartExclusive: "18:00",
          onceWeekly: false,
          examTime: time,
        }
      : null;
  }
  if (/^6:00 PM or any class after 6:00 PM meeting once weekly$/i.test(label)) {
    const time = parseHourRange(dayText.match(FIRST_MEETING_TEXT)?.[1] ?? "");
    return time
      ? { kind: "firstMeeting", label, minStart: "18:00", maxStartExclusive: null, onceWeekly: true, examTime: time }
      : null;
  }

  const evening = label.match(EVENING_PAIR_ROW);
  if (evening) {
    const start = clock(Number(evening[1]), Number(evening[2]), evening[3]!);
    const slot = parseSlot(dayText, hourText, year);
    const days = evening[4]!.toUpperCase() === "MW" ? ["MO", "WE"] : ["TU", "TH"];
    return start && slot ? { kind: "eveningPair", label, days, start, slot } : null;
  }

  const family = label.match(FAMILY_ROW);
  if (family) {
    const tokens = parseFamilyTokens(family[1]!, family[2]!);
    const slot = parseSlot(dayText, hourText, year);
    const familyName: DayFamily = family[3]!.toUpperCase() === "MWF" ? "MWF" : "TTh";
    return tokens && slot ? { kind: "family", label, family: familyName, ...tokens, slot } : null;
  }

  return null;
}

// "French 120, 150, 220; Performance (Vocal Arts) 261" → course keys. Returns null when any part
// names a department we can't map, so the whole row is reported rather than half-applied.
export function parseExceptionCourses(text: string): string[] | null {
  const courses: string[] = [];
  for (const part of clean(text).split(";")) {
    const match = clean(part).match(/^(.+?)\s+(\d{1,4}[A-Za-z]{0,3}(?:\s*,\s*\d{1,4}[A-Za-z]{0,3})*)$/);
    if (!match) {
      return null;
    }
    const code = DEPARTMENT_CODES.get(match[1]!.toLowerCase());
    if (!code) {
      return null;
    }
    for (const number of match[2]!.split(",")) {
      const key = normalizeCourseKey(`${code} ${clean(number)}`);
      if (!key) {
        return null;
      }
      courses.push(key);
    }
  }
  return courses.length > 0 ? courses : null;
}

function headerKey(table: Element): string {
  const headerRow = table.querySelector("thead tr") ?? table.querySelector("tr");
  return Array.from(headerRow?.querySelectorAll("th, td") ?? [], (cell) => clean(cell.textContent).toLowerCase()).join(
    " | ",
  );
}

function bodyRows(table: Element): string[][] {
  const rows = table.querySelector("tbody") ? table.querySelectorAll("tbody tr") : table.querySelectorAll("tr");
  return Array.from(rows, (row) => Array.from(row.querySelectorAll("td"), (cell) => clean(cell.textContent))).filter(
    (cells) => cells.length > 0,
  );
}

interface TermChapter {
  found: boolean;
  tables: Element[];
  text: string; // the chapter's paragraph text, for the finals window
}

// Every table between this term's anchor and the next chapter anchor, in document order.
function chapterTables(doc: Document, slug: string): TermChapter {
  const nodes = doc.querySelectorAll(".chaptered-nav-anchor, table, p");
  let active = false;
  let found = false;
  const tables: Element[] = [];
  const text: string[] = [];
  for (const node of nodes) {
    if (node.classList.contains("chaptered-nav-anchor")) {
      if (active) {
        break;
      }
      active = node.id === slug;
      found ||= active;
      continue;
    }
    if (!active) {
      continue;
    }
    if (node.tagName.toUpperCase() === "TABLE") {
      tables.push(node);
    } else if (!node.closest("table")) {
      text.push(clean(node.textContent));
    }
  }
  return { found, tables, text: text.join(" ") };
}

// "Final Examination Dates: December 9 – 16, 2026" or "May 5 – May 12, 2027".
function parseFinalsWindow(text: string): { start: string; end: string } | null {
  const match = text.match(
    /Final Examination Dates:\s*([A-Za-z]+)\s+(\d{1,2})\s*[–—-]\s*(?:([A-Za-z]+)\s+)?(\d{1,2}),\s*(\d{4})/i,
  );
  if (!match) {
    return null;
  }
  const year = Number(match[5]);
  const startMonth = MONTHS.get(match[1]!.toLowerCase());
  const endMonth = match[3] ? MONTHS.get(match[3].toLowerCase()) : startMonth;
  if (!startMonth || !endMonth) {
    return null;
  }
  const start = `${year}-${pad2(startMonth)}-${pad2(Number(match[2]))}`;
  const end = `${year}-${pad2(endMonth)}-${pad2(Number(match[4]))}`;
  return start <= end ? { start, end } : null;
}

function pickTable(tables: Element[], position: number, accepted: Set<string>): Element | null {
  const positioned = tables[position];
  if (positioned && accepted.has(headerKey(positioned))) {
    return positioned;
  }
  return tables.find((table) => accepted.has(headerKey(table))) ?? null;
}

export function parseFinalExamSchedule(doc: Document, termId: string): FinalExamsParseResult {
  const slug = termSlug(termId);
  if (!slug) {
    return { ok: false, error: `Term ${termId} has no university final exam schedule.` };
  }
  const chapter = chapterTables(doc, slug);
  if (!chapter.found) {
    return { ok: false, error: `No #${slug} section on the final exam page.` };
  }

  const gridTable = pickTable(chapter.tables, 0, GRID_HEADERS);
  const exceptionTable = pickTable(chapter.tables, 1, EXCEPTION_HEADERS);
  if (!gridTable || !exceptionTable) {
    const seen = chapter.tables.map(headerKey).join(" || ") || "no tables";
    return { ok: false, error: `Unrecognised final exam table headers for ${slug}: ${seen}` };
  }

  const finals = parseFinalsWindow(chapter.text);
  if (!finals) {
    return { ok: false, error: `Could not read the final examination dates for ${slug}.` };
  }
  const year = Number(finals.start.slice(0, 4));
  const inWindow = (date: string) => date >= finals.start && date <= finals.end;

  const unparsedRows: string[] = [];
  const unparsedExceptionNumbers = new Set<string>();
  const grid: GridRule[] = [];
  for (const cells of bodyRows(gridTable)) {
    const rule = parseGridRow(cells, year);
    if (!rule) {
      unparsedRows.push(`grid: ${cells.join(" | ")}`);
      continue;
    }
    if ("slot" in rule && !inWindow(rule.slot.date)) {
      return { ok: false, error: `Grid row "${rule.label}" falls outside ${finals.start}–${finals.end}.` };
    }
    grid.push(rule);
  }

  const exceptions: ExceptionEntry[] = [];
  for (const cells of bodyRows(exceptionTable)) {
    const courses = parseExceptionCourses(cells[0] ?? "");
    const slot = parseSlot(cells[1] ?? "", cells[2] ?? "", year);
    if (!courses || !slot) {
      unparsedRows.push(`exception: ${cells.join(" | ")}`);
      for (const match of (cells[0] ?? "").matchAll(/\b(\d{1,4}[A-Za-z]{0,3})\b/g)) {
        unparsedExceptionNumbers.add(match[1]!.toUpperCase());
      }
      continue;
    }
    if (!inWindow(slot.date)) {
      return { ok: false, error: `Exception "${cells[0]}" falls outside ${finals.start}–${finals.end}.` };
    }
    exceptions.push({ label: clean(cells[0]), courses, slot });
  }

  if (!grid.some((rule) => rule.kind === "family") || exceptions.length === 0) {
    return { ok: false, error: `The ${slug} grid or exceptions table parsed empty.` };
  }

  return {
    ok: true,
    data: {
      termId,
      finalsStart: finals.start,
      finalsEnd: finals.end,
      grid,
      exceptions,
      unparsedRows,
      unparsedExceptionNumbers: [...unparsedExceptionNumbers].sort(),
    },
  };
}
