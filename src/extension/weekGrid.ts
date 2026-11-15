// Pure layout for the week preview calendar: which days and hours to show, and where each class block goes.
// No React and no DOM, so every layout rule is unit-tested.
import { findOverlaps, type MeetingStatus, type WeeklyMeeting } from "@/extension/weekSchedule";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;
const WEEKEND = ["Saturday", "Sunday"] as const;
const SHORT_DAY = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
} as const satisfies Record<string, string>;
type DayName = keyof typeof SHORT_DAY;
const isDayName = (day: string): day is DayName => Object.hasOwn(SHORT_DAY, day);

/** "Thu" for "Thursday"; anything unrecognized is returned as is. */
export function shortDayName(day: string) {
  return isDayName(day) ? SHORT_DAY[day] : day;
}

/** The hours shown when nothing on the calendar falls outside them. */
export const DEFAULT_START_HOUR = 8;
export const DEFAULT_END_HOUR = 18;

/** A section being previewed (hovered or focused) on top of your calendar. */
export interface PreviewSection {
  /** e.g. "CSCI-104"; "" if unknown. */
  course: string;
  /** e.g. "30379R" */
  name: string;
  /** One entry per meeting pattern; most sections have one. */
  meetings: { days: string[]; time: { start: string; end: string } }[];
}

/**
 * scheduled: a class on your calendar. overlapped: one of those that the preview overlaps.
 * preview: the previewed section where it fits. previewOverlap: the previewed section where it overlaps something.
 */
export type BlockKind = "scheduled" | "overlapped" | "preview" | "previewOverlap";

export interface PreviewSummary {
  /** Your classes it overlaps, in calendar order (same rule as the course page's "Overlaps X" markers). */
  overlaps: WeeklyMeeting[];
  /** The section is already on your calendar, so nothing new is drawn. */
  alreadyScheduled: boolean;
}

export interface GridBlock {
  key: string;
  kind: BlockKind;
  /** For your own classes: myCalendar's status (Registered, Scheduled...), which picks the block's color. */
  status?: MeetingStatus;
  course: string;
  section: string;
  /** Column in `days`. */
  dayIndex: number;
  /** Side-by-side lane when classes on the same day overlap; `lane` of `lanes`. */
  lane: number;
  lanes: number;
  /** Pixels from the top of the grid. */
  top: number;
  height: number;
  /** e.g. "4:00–5:20 PM" */
  timeLabel: string;
}

export interface WeekGrid {
  /** Full weekday names, in column order. Mon–Fri always; Sat/Sun only when a class meets then. */
  days: string[];
  shortDays: string[];
  startHour: number;
  endHour: number;
  height: number;
  hourMarks: { hour: number; label: string; top: number }[];
  blocks: GridBlock[];
  /** Present when a preview section was given. */
  preview?: PreviewSummary;
}

type Placed = WeeklyMeeting & { kind: BlockKind };

function minutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

function clock(totalMinutes: number) {
  const h24 = Math.floor(totalMinutes / 60) % 24;
  const h12 = h24 % 12 || 12;
  return { text: `${h12}:${String(totalMinutes % 60).padStart(2, "0")}`, meridiem: h24 < 12 ? "AM" : "PM" };
}

/** "4:00–5:20 PM", or "11:00 AM–12:20 PM" when the meridiem changes. */
export function formatTimeRange(start: string, end: string) {
  const a = clock(minutes(start));
  const b = clock(minutes(end));
  return a.meridiem === b.meridiem
    ? `${a.text}–${b.text} ${b.meridiem}`
    : `${a.text} ${a.meridiem}–${b.text} ${b.meridiem}`;
}

function hourLabel(hour: number) {
  const h = hour % 24;
  if (h === 0) {
    return "12a";
  }
  if (h === 12) {
    return "12p";
  }
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

/** Assigns overlapping meetings on one day to side-by-side lanes (greedy, in start-time order). */
function assignLanes(dayMeetings: Placed[]) {
  // Your own classes before a preview that starts at the same time, so the preview sits to their right.
  const previewLast = (m: Placed) => (m.kind === "preview" || m.kind === "previewOverlap" ? 1 : 0);
  const sorted = [...dayMeetings].sort(
    (a, b) => a.start.localeCompare(b.start) || previewLast(a) - previewLast(b) || a.end.localeCompare(b.end),
  );
  const placed: { meeting: Placed; lane: number; group: number }[] = [];
  let laneEnds: string[] = [];
  let group = -1;
  let groupEnd = "";
  for (const meeting of sorted) {
    // A new group starts when this meeting begins after everything so far has ended.
    if (meeting.start >= groupEnd) {
      group += 1;
      laneEnds = [];
    }
    let lane = laneEnds.findIndex((end) => end <= meeting.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(meeting.end);
    } else {
      laneEnds[lane] = meeting.end;
    }
    groupEnd = meeting.start >= groupEnd ? meeting.end : groupEnd > meeting.end ? groupEnd : meeting.end;
    placed.push({ meeting, lane, group });
  }
  const lanesPerGroup = new Map<number, number>();
  for (const { lane, group: g } of placed) {
    lanesPerGroup.set(g, Math.max(lanesPerGroup.get(g) ?? 0, lane + 1));
  }
  return placed.map(({ meeting, lane, group: g }) => ({ meeting, lane, lanes: lanesPerGroup.get(g)! }));
}

export function buildWeekGrid(meetings: WeeklyMeeting[], pxPerHour = 34, preview?: PreviewSection): WeekGrid {
  const usable = meetings.filter((m) => isDayName(m.day) && m.start < m.end);
  let summary: PreviewSummary | undefined;
  let placedMeetings: Placed[] = usable.map((m) => ({ ...m, kind: "scheduled" }));
  if (preview) {
    const alreadyScheduled = usable.some((m) => m.section !== "" && preview.name.startsWith(m.section));
    // Overlaps per pattern, then all of them in calendar order without repeats.
    const perPattern = preview.meetings.map((pattern) =>
      alreadyScheduled
        ? []
        : findOverlaps({ name: preview.name, type: undefined, days: pattern.days, time: pattern.time }, usable),
    );
    const overlaps = usable.filter((m) => perPattern.some((list) => list.includes(m)));
    summary = { overlaps, alreadyScheduled };
    if (!alreadyScheduled) {
      preview.meetings.forEach((pattern, index) => {
        if (pattern.time.start >= pattern.time.end) {
          return;
        }
        for (const day of pattern.days.filter(isDayName)) {
          const hitsThatDay = perPattern[index]!.some((m) => m.day === day);
          placedMeetings.push({
            course: preview.course || "Section",
            section: preview.name,
            day,
            start: pattern.time.start,
            end: pattern.time.end,
            kind: hitsThatDay ? "previewOverlap" : "preview",
          });
        }
      });
    }
  }
  // findOverlaps returns the original meeting objects; the first usable.length entries line up with them.
  if (summary) {
    const overlapped = new Set(summary.overlaps);
    placedMeetings = placedMeetings.map((m, index) =>
      index < usable.length && overlapped.has(usable[index]!) ? { ...m, kind: "overlapped" } : m,
    );
  }
  const days: DayName[] = [...WEEKDAYS, ...WEEKEND.filter((day) => placedMeetings.some((m) => m.day === day))];

  let startHour = DEFAULT_START_HOUR;
  let endHour = DEFAULT_END_HOUR;
  for (const m of placedMeetings) {
    startHour = Math.min(startHour, Math.floor(minutes(m.start) / 60));
    endHour = Math.max(endHour, Math.ceil(minutes(m.end) / 60));
  }
  const pxPerMinute = pxPerHour / 60;
  const top = (hhmm: string) => Math.round((minutes(hhmm) - startHour * 60) * pxPerMinute);

  const blocks: GridBlock[] = [];
  days.forEach((day, dayIndex) => {
    for (const { meeting, lane, lanes } of assignLanes(placedMeetings.filter((m) => m.day === day))) {
      const block: GridBlock = {
        key: JSON.stringify([meeting.kind, meeting.course, meeting.section, day, meeting.start, meeting.end]),
        kind: meeting.kind,
        course: meeting.course,
        section: meeting.section,
        dayIndex,
        lane,
        lanes,
        top: top(meeting.start),
        height: top(meeting.end) - top(meeting.start),
        timeLabel: formatTimeRange(meeting.start, meeting.end),
      };
      if (meeting.status) {
        block.status = meeting.status;
      }
      blocks.push(block);
    }
  });

  const hourMarks = [];
  for (let hour = startHour; hour <= endHour; hour += 1) {
    hourMarks.push({ hour, label: hourLabel(hour), top: Math.round((hour - startHour) * pxPerHour) });
  }
  const grid: WeekGrid = {
    days,
    shortDays: days.map((day) => SHORT_DAY[day]),
    startHour,
    endHour,
    height: Math.round((endHour - startHour) * pxPerHour),
    hourMarks,
    blocks,
  };
  if (summary) {
    grid.preview = summary;
  }
  return grid;
}
