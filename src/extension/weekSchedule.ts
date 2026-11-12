// Pure schedule model shared by the course-page "Overlaps X" markers and the week preview.
// No jQuery and no page writes: callers decide what to do with the results.
import { parseTimeRange } from "@/extension/courseBinScrape";
import type { Schedule } from "@/extension/scheduleDocument";

// Moved verbatim from utils.ts (unchanged behavior: unmapped letters such as Saturday's are kept as-is).
export function splitDays(days: string | undefined) {
  if (!days) {
    return [];
  }
  //Split Thursday first because otherwise it'll get split on Tuesday
  const split = days.replace("Th", "D").split("");
  for (let i = 0; i < split.length; i++) {
    switch (split[i]) {
      case "M":
        split[i] = "Monday";
        break;
      case "T":
        split[i] = "Tuesday";
        break;
      case "W":
        split[i] = "Wednesday";
        break;
      case "D":
        split[i] = "Thursday";
        break;
      case "F":
        split[i] = "Friday";
        break;
    }
  }
  return split;
}

const USC_TIMEZONE = "America/Los_Angeles";
const uscDayFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  timeZone: USC_TIMEZONE,
});
const uscTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: USC_TIMEZONE,
});

function parseScheduleDate(dateLike: string | Date) {
  if (dateLike instanceof Date) {
    return Number.isNaN(dateLike.getTime()) ? null : dateLike;
  }
  const microsoftJsonDateMatch = dateLike.match(/\/Date\((\d+)(?:[-+]\d+)?\)\//);
  if (microsoftJsonDateMatch) {
    const parsedDate = new Date(Number(microsoftJsonDateMatch[1]));
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }
  const parsedDate = new Date(dateLike);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function formatScheduleDayInLosAngeles(dateLike: string | Date) {
  const parsedDate = parseScheduleDate(dateLike);
  return parsedDate ? uscDayFormatter.format(parsedDate) : null;
}

function formatScheduleTimeInLosAngeles(dateLike: string | Date) {
  const parsedDate = parseScheduleDate(dateLike);
  return parsedDate ? uscTimeFormatter.format(parsedDate) : null;
}

/** One weekly meeting of a class on your calendar, in USC local time. */
export interface WeeklyMeeting {
  /** Course code as WebReg's calendar titles it, e.g. "CSCI-270". */
  course: string;
  /** Section number without the brackets and trailing letter, e.g. "29905" from "(29905R)". */
  section: string;
  /** Full weekday name, e.g. "Thursday". */
  day: string;
  /** "HH:mm", 24-hour. Fixed width, so strings compare in time order. */
  start: string;
  end: string;
}

/**
 * Turns WebReg's calendar entries (one per class occurrence) into weekly meetings.
 * Exact repeats (same course, section, weekday and times) are kept once, in first-appearance order.
 * A repeat can never be the first overlap when its first copy wasn't, so which class is reported is unchanged.
 */
export function weeklyMeetings(data: Schedule | null | undefined): WeeklyMeeting[] {
  if (!data?.Data?.length) {
    return [];
  }
  const meetings: WeeklyMeeting[] = [];
  const seen = new Set<string>();
  for (const entry of data.Data) {
    const day = formatScheduleDayInLosAngeles(entry.Start);
    const start = formatScheduleTimeInLosAngeles(entry.Start);
    const end = formatScheduleTimeInLosAngeles(entry.End);
    if (!day || !start || !end) {
      continue;
    }
    const [course, sectionName] = entry.Title.split(" ");
    if (!course || !sectionName) {
      continue;
    }
    const meeting = { course, section: sectionName.slice(1, -2), day, start, end };
    // JSON keeps the fields apart even when a title contains the separator a join would use.
    const key = JSON.stringify([meeting.course, meeting.section, day, start, end]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    meetings.push(meeting);
  }
  return meetings;
}

/** What a course-page section row says about itself. */
export interface SectionRowInfo {
  /** e.g. "29905R"; empty when the row has no Section line. */
  name: string;
  /** e.g. "Lecture", "Lab"; undefined when the row has no Type line. */
  type: string | undefined;
  /** Full weekday names from the Days line. */
  days: string[];
  /** null for TBA or a missing Time line. A malformed time throws (from parseTimeRange) instead. */
  time: { start: string; end: string } | null;
}

/** The labelled `.section_row` lines of a WebReg course-page `.section` element. */
export function sectionRows(sectionElement: Element): HTMLElement[] {
  return Array.from(sectionElement.querySelectorAll<HTMLElement>(".section_row"));
}

/** The value after "Label: " on the first row that mentions "Label:", trimmed; undefined if no row does. */
export function sectionRowValue(rows: HTMLElement[], label: "Section" | "Type" | "Days" | "Time") {
  return rows
    .find((row) => row.innerText.includes(`${label}:`))
    ?.innerText?.replace(`${label}: `, "")
    ?.trim();
}

/** Reads every field of a WebReg course-page `.section` element. Throws on a malformed time. */
export function readSectionRow(sectionElement: Element): SectionRowInfo {
  const rows = sectionRows(sectionElement);
  const time = parseTimeRange(sectionRowValue(rows, "Time"));
  return {
    name: sectionRowValue(rows, "Section") || "",
    type: sectionRowValue(rows, "Type"),
    days: splitDays(sectionRowValue(rows, "Days")),
    time,
  };
}

/**
 * Calendar meetings that overlap a section, in calendar order. Your own copy of the section is skipped,
 * and touching endpoints (one ends as the other starts) don't overlap.
 */
export function findOverlaps(section: SectionRowInfo, meetings: WeeklyMeeting[]): WeeklyMeeting[] {
  const { time } = section;
  if (!time) {
    return [];
  }
  return meetings.filter(
    (meeting) =>
      !section.name.startsWith(meeting.section) &&
      section.days.includes(meeting.day) &&
      meeting.start < time.end &&
      time.start < meeting.end,
  );
}
