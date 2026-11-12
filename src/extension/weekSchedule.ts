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
  /** myCalendar's status, which sets its color there (and in the week preview). */
  status?: MeetingStatus;
}

export type MeetingStatus = "registered" | "scheduled" | "conflicted" | "other";

/** Most important first: a duplicate entry keeps the earliest of these. */
const STATUS_RANK: (MeetingStatus | undefined)[] = ["registered", "conflicted", "scheduled", "other", undefined];

function meetingStatus(status: string | undefined): MeetingStatus | undefined {
  if (status === undefined) {
    return undefined;
  }
  const lower = status.trim().toLowerCase();
  return lower === "registered" || lower === "scheduled" || lower === "conflicted" ? lower : "other";
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
  const seen = new Map<string, WeeklyMeeting>();
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
    const status = meetingStatus(entry.Status);
    const meeting: WeeklyMeeting = { course, section: sectionName.slice(1, -2), day, start, end };
    if (status) {
      meeting.status = status;
    }
    // JSON keeps the fields apart even when a title contains the separator a join would use.
    const key = JSON.stringify([meeting.course, meeting.section, day, start, end]);
    const earlier = seen.get(key);
    if (earlier) {
      // The same class listed twice keeps the status that matters most, whichever order myCalendar used.
      if (STATUS_RANK.indexOf(meeting.status) < STATUS_RANK.indexOf(earlier.status)) {
        earlier.status = meeting.status;
      }
      continue;
    }
    seen.set(key, meeting);
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

// Text of a node with <br> as a line break, leaving out WebReg's small-screen labels ("Time: " and so on).
function textWithBreaks(node: Node): string {
  if (node.nodeType === 3) {
    return node.textContent ?? "";
  }
  if (node.nodeType === 1) {
    // SAFETY: nodeType 1 is the DOM's discriminator for Element nodes.
    const element = node as Element;
    if (element.classList.contains("table-headers-xsmall")) {
      return "";
    }
    if (element.tagName.toUpperCase() === "BR") {
      return "\n";
    }
  }
  return Array.from(node.childNodes, textWithBreaks).join("");
}

/**
 * The value of a section's "Label:" row, trimmed (lines joined with "\n"); undefined if there's no such row.
 *
 * WebReg puts each label in a `.table-headers-xsmall` span that Bootstrap hides at desktop widths, so this reads
 * the markup (textContent), never the rendered text (innerText, which drops hidden text and so the labels too).
 * Rows without that span (older markup) fall back to matching "Label:" in their text.
 */
export function sectionRowValue(rows: HTMLElement[], label: "Section" | "Type" | "Days" | "Time") {
  const labelled = rows.find(
    (row) => row.querySelector(".table-headers-xsmall")?.textContent?.trim().replace(/:\s*$/, "") === label,
  );
  if (labelled) {
    return textWithBreaks(labelled)
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }
  return rows
    .find((row) => (row.textContent ?? "").includes(`${label}:`))
    ?.textContent?.replace(`${label}: `, "")
    ?.trim();
}

/**
 * A section's meeting patterns, as raw text. WebReg prints one line per pattern in both the Time and Days cells
 * (e.g. "01:00pm-05:50pm" / "02:00pm-03:50pm" with "M" / "W"); line i of Time goes with line i of Days, the same
 * rule Final Exams uses. null when the cells don't pair up, so nothing is guessed. [] for no time (or TBA).
 */
export function sectionMeetingLines(rows: HTMLElement[]): { time: string; days: string }[] | null {
  const timeLines = (sectionRowValue(rows, "Time") ?? "").split("\n").filter(Boolean);
  if (timeLines.length <= 1) {
    return timeLines.map((time) => ({ time, days: sectionRowValue(rows, "Days") ?? "" }));
  }
  const dayLines = (sectionRowValue(rows, "Days") ?? "").split("\n").filter(Boolean);
  if (dayLines.length !== timeLines.length) {
    return null;
  }
  return timeLines.map((time, index) => ({ time, days: dayLines[index]! }));
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
