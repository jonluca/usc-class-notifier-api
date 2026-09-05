// RFC 5545 (iCalendar) generator. Pure logic — no DOM, no jQuery, no chrome.*, no USC-specific
// scraping. Input: a plain schedule object (see Term/Section/Meeting below). Output: a
// CRLF-joined .ics string.
//
// Emits DTSTART/DTEND under a real America/Los_Angeles TZID with a full VTIMEZONE block, a
// UTC-converted UNTIL, and holiday EXDATEs filtered by meeting weekday (unused until holiday
// data exists, but the branch is already correct and conditional). DST is hand-rolled from the
// stated US rule (2nd Sunday of March / 1st Sunday of November, in effect since 2007) rather
// than via Intl — deterministic, and doesn't depend on the runtime shipping full ICU tzdata.
//
// Ported from the ScheduleHelper+ prototype's ics.js: verified against a real Google Calendar
// import and covered by 150+ tests there. Kept as plain logic per instruction, not preserved as
// a zero-dependency module — this codebase already has dependencies, so that constraint doesn't
// apply here.

const CRLF = "\r\n";
const FOLD_LIMIT_OCTETS = 75;
const DAY_INDEX = new Map<string, number>([
  ["SU", 0],
  ["MO", 1],
  ["TU", 2],
  ["WE", 3],
  ["TH", 4],
  ["FR", 5],
  ["SA", 6],
]);
const DAY_CODES_BY_INDEX = new Map<number, string>([...DAY_INDEX.entries()].map(([code, index]) => [index, code]));
const TZID = "America/Los_Angeles";

export interface Holiday {
  date: string;
  name: string;
}

export interface Term {
  id: string;
  name: string;
  firstDay: string;
  lastDay: string;
  holidays?: Holiday[];
}

export interface Meeting {
  days: string[];
  start?: string;
  end?: string;
  location?: string;
}

export interface SectionSession {
  id: string;
  firstDay: string;
  lastDay: string;
  holidays?: Holiday[];
}

export interface Section {
  id: string;
  session?: SectionSession;
  course: string;
  title: string;
  type: string;
  instructor: string;
  meetings: Meeting[];
}

export interface Schedule {
  term: Term;
  sections: Section[];
}

export interface GenerateICSOptions {
  generatedAt?: Date;
}

export function escapeText(str: string): string {
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Fold a single unfolded content line at 75 octets (UTF-8 byte count, not JS char count).
// Continuation lines start with a single space per RFC 5545 §3.1. A fold may occur between any
// two characters, including next to whitespace; avoiding whitespace boundaries can move the
// split into a multi-byte code point and corrupt the text.
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function foldLine(line: string): string {
  const bytes = utf8Encoder.encode(line);
  if (bytes.length <= FOLD_LIMIT_OCTETS) {
    return line;
  }

  const chunks: string[] = [];
  let start = 0;
  let limit = FOLD_LIMIT_OCTETS;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    if (end < bytes.length) {
      // Don't split a multi-byte UTF-8 sequence: back off while the next byte is a
      // continuation byte (10xxxxxx).
      while (end > start && (bytes[end]! & 0xc0) === 0x80) {
        end--;
      }
    }
    chunks.push(utf8Decoder.decode(bytes.subarray(start, end)));
    start = end;
    limit = FOLD_LIMIT_OCTETS - 1; // continuation lines lose 1 octet to the leading space
  }

  return chunks.join(CRLF + " ");
}

// Inverse of foldLine, exported for round-trip testing only — not part of generateICS's contract.
export function unfoldLines(icsText: string): string {
  return icsText.replace(/\r\n[ \t]/g, "");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dateDigits(iso: string): string {
  return iso.replace(/-/g, "");
}

function localDateTimeDigits(iso: string, hhmm: string): string {
  const [hh, mm] = hhmm.split(":");
  return `${dateDigits(iso)}T${pad2(Number(hh))}${pad2(Number(mm))}00`;
}

function utcDateTimeDigits(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error("generatedAt must be a valid Date");
  }

  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
  );
}

// First date on or after firstDayISO whose weekday is in days (RFC 5545 day codes).
// DTSTART must satisfy the RRULE's BYDAY, or clients invent a phantom first occurrence.
export function firstOccurrenceOnOrAfter(firstDayISO: string, days: string[]): string {
  const wanted = new Set(days.map((d) => DAY_INDEX.get(d)));
  const start = new Date(`${firstDayISO}T00:00:00Z`);
  for (let offset = 0; offset < 7; offset++) {
    const candidate = new Date(start.getTime() + offset * 86400000);
    if (wanted.has(candidate.getUTCDay())) {
      const y = candidate.getUTCFullYear();
      const m = pad2(candidate.getUTCMonth() + 1);
      const d = pad2(candidate.getUTCDate());
      return `${y}-${m}-${d}`;
    }
  }
  throw new Error(`no weekday in [${days.join(",")}] found within a week of ${firstDayISO}`);
}

// RFC 5545 day code for a given ISO date, e.g. for matching a holiday's weekday against a
// meeting's BYDAY set.
function dayCodeOf(dateISO: string): string {
  const dow = new Date(`${dateISO}T00:00:00Z`).getUTCDay();
  return DAY_CODES_BY_INDEX.get(dow)!;
}

// Day-of-month (1-based) of the nth Sunday of a given month.
function nthSundayOfMonth(year: number, month: number, n: number): number {
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const firstSunday = 1 + ((7 - firstOfMonth.getUTCDay()) % 7);
  return firstSunday + (n - 1) * 7;
}

// US DST since 2007: forward 2nd Sunday of March, back 1st Sunday of November, both 02:00 local.
// Date-level granularity is deliberate — the only case it can't distinguish is the 1-2am hour on
// the transition day itself, and no class meets then.
function dstBoundsForYear(year: number) {
  return {
    start: `${year}-03-${pad2(nthSundayOfMonth(year, 3, 2))}`,
    end: `${year}-11-${pad2(nthSundayOfMonth(year, 11, 1))}`,
  };
}

// -7 (PDT) if dateISO falls within DST, else -8 (PST). Exported for direct unit testing.
export function utcOffsetHours(dateISO: string): number {
  const { start, end } = dstBoundsForYear(Number(dateISO.slice(0, 4)));
  return dateISO >= start && dateISO < end ? -7 : -8;
}

// Local wall-clock date+time at a known UTC offset (hours, e.g. -8), converted to UTC digits
// with a trailing Z. Used only for UNTIL — DTSTART/DTEND/EXDATE stay as local wall-clock digits
// under a TZID param, which is the entire point of embedding VTIMEZONE.
function localToUTCDigits(dateISO: string, hhmmss: string, offsetHours: number): string {
  const [hh, mm, ss] = hhmmss.split(":").map(Number);
  const [y, mo, d] = dateISO.split("-").map(Number);
  const utc = new Date(Date.UTC(y!, mo! - 1, d!, hh, mm, ss) - offsetHours * 3600000);
  const digits =
    `${utc.getUTCFullYear()}${pad2(utc.getUTCMonth() + 1)}${pad2(utc.getUTCDate())}` +
    `T${pad2(utc.getUTCHours())}${pad2(utc.getUTCMinutes())}${pad2(utc.getUTCSeconds())}`;
  return `${digits}Z`;
}

// Standard America/Los_Angeles VTIMEZONE, anchored at the 2007 rule change so there's no
// ambiguity with the pre-2007 US DST schedule (irrelevant to any term this tool supports, but
// anchoring elsewhere would be misleading).
function buildVTimezoneLines(): string[] {
  return [
    "BEGIN:VTIMEZONE",
    `TZID:${TZID}`,
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:-0800",
    "TZOFFSETTO:-0700",
    "TZNAME:PDT",
    "DTSTART:20070311T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:-0700",
    "TZOFFSETTO:-0800",
    "TZNAME:PST",
    "DTSTART:20071104T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
}

// Holidays whose weekday matches this meeting's own days, within [dtstartDate, lastDay]. A
// holiday only excludes a date the class was actually meeting on — a Thanksgiving Thursday
// exclusion doesn't apply to a Mon/Wed/Fri class, for instance.
function resolveExdatesForMeeting(term: Term, meeting: Meeting, dtstartDate: string): string[] {
  const meetingDays = new Set(meeting.days);
  return (term.holidays ?? [])
    .filter((h) => h.date >= dtstartDate && h.date <= term.lastDay)
    .filter((h) => meetingDays.has(dayCodeOf(h.date)))
    .map((h) => h.date);
}

function isMeetingExportable(meeting: Meeting): boolean {
  return Boolean(meeting.days?.length && meeting.start && meeting.end);
}

export function countExportableMeetings(schedule: Schedule): number {
  let count = 0;
  for (const section of schedule.sections) {
    for (const meeting of section.meetings) {
      if (isMeetingExportable(meeting)) {
        count++;
      }
    }
  }
  return count;
}

function buildUID(termId: string, sectionId: string, suffix: string | number): string {
  return `${termId}-${sectionId}-${suffix}@usc.jonlu.ca`;
}

function termForSection(term: Term, section: Section): Term {
  if (!section.session) {
    return term;
  }

  const holidays = new Map<string, Holiday>();
  for (const holiday of [...(term.holidays ?? []), ...(section.session.holidays ?? [])]) {
    holidays.set(holiday.date, holiday);
  }

  return {
    ...term,
    firstDay: section.session.firstDay,
    lastDay: section.session.lastDay,
    holidays: [...holidays.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function buildRecurringMeetingEvent(
  term: Term,
  section: Section,
  meeting: Meeting,
  meetingIndex: number,
  dtstamp: string,
): string[] {
  const dtstartDate = firstOccurrenceOnOrAfter(term.firstDay, meeting.days);
  if (dtstartDate > term.lastDay) {
    throw new Error(`Section ${section.id} has no meeting day within session ${section.session?.id ?? term.id}.`);
  }
  const dtstart = localDateTimeDigits(dtstartDate, meeting.start!);
  const dtend = localDateTimeDigits(dtstartDate, meeting.end!);
  const until = localToUTCDigits(term.lastDay, "23:59:59", utcOffsetHours(term.lastDay));
  const summary = `${section.course} ${section.type}`;
  const description = [section.title, section.instructor].filter(Boolean).join(" — ");
  const exdates = resolveExdatesForMeeting(term, meeting, dtstartDate);

  const lines = [
    "BEGIN:VEVENT",
    `UID:${buildUID(term.id, section.id, meetingIndex)}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=${TZID}:${dtstart}`,
    `DTEND;TZID=${TZID}:${dtend}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${meeting.days.join(",")};UNTIL=${until}`,
  ];
  if (exdates.length > 0) {
    const exdateDigits = exdates.map((date) => localDateTimeDigits(date, meeting.start!));
    lines.push(`EXDATE;TZID=${TZID}:${exdateDigits.join(",")}`);
  }
  lines.push(`SUMMARY:${escapeText(summary)}`);
  if (description) {
    lines.push(`DESCRIPTION:${escapeText(description)}`);
  }
  if (meeting.location) {
    lines.push(`LOCATION:${escapeText(meeting.location)}`);
  }
  lines.push("END:VEVENT");
  return lines;
}

export function generateICS(schedule: Schedule, options: GenerateICSOptions = {}): string {
  const { term, sections } = schedule;
  const dtstamp = utcDateTimeDigits(options.generatedAt ?? new Date());
  const contentLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//usc-schedule-export//EN",
    ...buildVTimezoneLines(),
  ];

  for (const section of sections) {
    const sectionTerm = termForSection(term, section);
    section.meetings.forEach((meeting, meetingIndex) => {
      if (!isMeetingExportable(meeting)) {
        return;
      }
      contentLines.push(...buildRecurringMeetingEvent(sectionTerm, section, meeting, meetingIndex, dtstamp));
    });
  }

  contentLines.push("END:VCALENDAR");

  return contentLines.map(foldLine).join(CRLF) + CRLF;
}
