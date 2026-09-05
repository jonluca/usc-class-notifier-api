// Pure string parsers for USC's day/time/location formats on /CourseBin — testable, no DOM. Kept
// jQuery-free on purpose: jQuery throws at import time without a real window/document, so
// anything imported from this file must stay safely importable under node:test. The DOM adapter
// that consumes these lives in courseBinDom.ts.

import { USC_BUILDINGS } from "@/extension/uscBuildings";

// The real server route is /CourseBin (capital C, capital B, no "my" prefix) — confirmed by
// inspecting the nav link's actual href. Its *display text* reads "myCourseBin", and the browser
// address bar shows /myCourseBin after the page's own client-side routing kicks in once loaded,
// which is what src/extension/extension.ts's unrelated `currentURL.includes("/myCourseBin")`
// check is matching against. But a fetch() has to hit the real server path, not the post-routing
// display URL — fetching /myCourseBin 404s. Exported so calendarExport.ts's fetch and this
// file's test both derive from one source of truth instead of two hardcoded strings that can
// drift apart.
export const COURSE_BIN_URL = "https://webreg.usc.edu/CourseBin";

const TWO_LETTER_DAY_TOKENS: [string, string][] = [
  ["TH", "TH"],
  ["TU", "TU"],
  ["SU", "SU"],
  ["MO", "MO"],
  ["WE", "WE"],
  ["FR", "FR"],
  ["SA", "SA"],
];
const ONE_LETTER_DAY_TOKENS = new Map([
  ["M", "MO"],
  ["T", "TU"],
  ["W", "WE"],
  ["F", "FR"],
]);

// USC day-code tokenizer. Confirmed dialect: Th/TTh, not Tu/TuTh — but both are supported since
// classes.usc.edu may differ. Two-letter tokens (Th, Tu, ...) are tried before one-letter ones
// at every position, or "TTh" would tokenize as Tuesday + garbage.
export function parseDays(str: string | undefined | null): string[] {
  const normalized = (str ?? "").trim().toUpperCase();
  if (normalized === "" || normalized === "TBA" || normalized === "TBD") {
    return [];
  }

  const stripped = normalized.replace(/[,/\s]/g, "");
  const days: string[] = [];
  let i = 0;
  while (i < stripped.length) {
    const twoLetter = stripped.slice(i, i + 2);
    const match = TWO_LETTER_DAY_TOKENS.find(([token]) => token === twoLetter);
    if (match) {
      days.push(match[1]);
      i += 2;
      continue;
    }
    const oneLetter = stripped[i]!;
    const mappedDay = ONE_LETTER_DAY_TOKENS.get(oneLetter);
    if (mappedDay) {
      days.push(mappedDay);
      i += 1;
      continue;
    }
    throw new Error(`unrecognized day code "${oneLetter}" in "${str}"`);
  }
  return days;
}

const TIME_RANGE_RE = /^(\d{1,2}):(\d{2})\s*(am|pm)?\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)?$/i;

function to24Hour(hour12: number, meridiem: string): number {
  const h = hour12 % 12;
  return meridiem.toLowerCase() === "pm" ? h + 12 : h;
}

function formatHHMM(hour24: number, minute: number): string {
  return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// USC prints times like "11:00-12:50pm" — meridiem only on the end. Infer the start's meridiem
// from the end's; if that makes the start later than the end, roll it back 12h.
export function parseTimeRange(str: string | undefined | null): { start: string; end: string } | null {
  const trimmed = (str ?? "").trim();
  if (trimmed === "" || trimmed.toUpperCase() === "TBA") {
    return null;
  }

  const match = trimmed.match(TIME_RANGE_RE);
  if (!match) {
    throw new Error(`unrecognized time range "${str}"`);
  }

  const [, startHourStr, startMinStr, startMeridiem, endHourStr, endMinStr, endMeridiem] = match;
  if (!endMeridiem) {
    throw new Error(`time range "${str}" is missing an end meridiem`);
  }

  const startHour = Number(startHourStr);
  const startMin = Number(startMinStr);
  const endHour = Number(endHourStr);
  const endMin = Number(endMinStr);
  if (startHour < 1 || startHour > 12 || endHour < 1 || endHour > 12 || startMin > 59 || endMin > 59) {
    throw new Error(`time range "${str}" contains an invalid clock time`);
  }

  const endHour24 = to24Hour(endHour, endMeridiem);
  const endTotal = endHour24 * 60 + endMin;

  const meridiemForStart = startMeridiem ?? endMeridiem;
  let startHour24 = to24Hour(startHour, meridiemForStart);
  let startTotal = startHour24 * 60 + startMin;

  if (!startMeridiem && startTotal > endTotal) {
    startHour24 = (startHour24 + 12) % 24;
    startTotal = startHour24 * 60 + startMin;
  }

  if (endTotal <= startTotal) {
    throw new Error(`time range "${str}" must end after it starts`);
  }

  return { start: formatHHMM(startHour24, startMin), end: formatHHMM(endHour24, endMin) };
}

// Building codes on /CourseBin are a fixed 3 letters, so the split is fixed-length, not a
// lookup-driven guess (e.g. "WPHB27" -> "WPH" + "B27", never "WP" + "HB27"). Unmapped codes
// (including the literal "TBD", which isn't a real building code) fall through to `raw`
// unchanged rather than throwing — a missing/renamed code shouldn't break the export.
export function expandLocation(raw: string): string {
  const code = raw.slice(0, 3).toUpperCase();
  const name = USC_BUILDINGS.get(code);
  if (!name) {
    return raw;
  }

  const room = raw.slice(3);
  return room ? `${room}, ${name}` : name;
}
