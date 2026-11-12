// Pure layout for the week preview calendar: which days and hours to show, and where each class block goes.
// No React and no DOM, so every layout rule is unit-tested.
import type { WeeklyMeeting } from "@/extension/weekSchedule";

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

/** The hours shown when nothing on the calendar falls outside them. */
export const DEFAULT_START_HOUR = 8;
export const DEFAULT_END_HOUR = 18;

export interface GridBlock {
  key: string;
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
}

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
function assignLanes(dayMeetings: WeeklyMeeting[]) {
  const sorted = [...dayMeetings].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const placed: { meeting: WeeklyMeeting; lane: number; group: number }[] = [];
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

export function buildWeekGrid(meetings: WeeklyMeeting[], pxPerHour = 34): WeekGrid {
  const usable = meetings.filter((m) => isDayName(m.day) && m.start < m.end);
  const days: DayName[] = [...WEEKDAYS, ...WEEKEND.filter((day) => usable.some((m) => m.day === day))];

  let startHour = DEFAULT_START_HOUR;
  let endHour = DEFAULT_END_HOUR;
  for (const m of usable) {
    startHour = Math.min(startHour, Math.floor(minutes(m.start) / 60));
    endHour = Math.max(endHour, Math.ceil(minutes(m.end) / 60));
  }
  const pxPerMinute = pxPerHour / 60;
  const top = (hhmm: string) => Math.round((minutes(hhmm) - startHour * 60) * pxPerMinute);

  const blocks: GridBlock[] = [];
  days.forEach((day, dayIndex) => {
    for (const { meeting, lane, lanes } of assignLanes(usable.filter((m) => m.day === day))) {
      blocks.push({
        key: JSON.stringify([meeting.course, meeting.section, day, meeting.start, meeting.end]),
        course: meeting.course,
        section: meeting.section,
        dayIndex,
        lane,
        lanes,
        top: top(meeting.start),
        height: top(meeting.end) - top(meeting.start),
        timeLabel: formatTimeRange(meeting.start, meeting.end),
      });
    }
  });

  const hourMarks = [];
  for (let hour = startHour; hour <= endHour; hour += 1) {
    hourMarks.push({ hour, label: hourLabel(hour), top: Math.round((hour - startHour) * pxPerHour) });
  }
  return {
    days,
    shortDays: days.map((day) => SHORT_DAY[day]),
    startHour,
    endHour,
    height: Math.round((endHour - startHour) * pxPerHour),
    hourMarks,
    blocks,
  };
}
