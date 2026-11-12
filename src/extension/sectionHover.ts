// Which WebReg course-page section the person is pointing at (or has tabbed into), for the week preview.
// One delegated listener set on the document, so it keeps working when WebReg expands accordions or re-renders rows.
import { useEffect, useState } from "react";
import { parseDays, parseTimeRange } from "@/extension/courseBinScrape";
import { sectionMeetingLines, sectionRowName, sectionRows, sectionRowValue } from "@/extension/weekSchedule";

/** One meeting pattern of a section: these days, at this time. */
export interface SectionMeeting {
  /** Full weekday names. */
  days: string[];
  time: { start: string; end: string };
}

/** A section row as the week preview shows it. */
export interface HoveredSection {
  /** e.g. "CSCI-104"; "" when the course header can't be read. */
  course: string;
  /** e.g. "30379 R" */
  name: string;
  type: string | undefined;
  /** Its meeting patterns (most sections have one). Empty for TBA, or when they can't be read. */
  meetings: SectionMeeting[];
  /** The Time/Days cells have something we couldn't read (rather than a plain "TBA"). */
  unreadable: boolean;
}

/** A hovered section plus the row it came from, so the row can be marked. */
export interface HoveredSectionOnPage extends HoveredSection {
  element: Element;
}

const COURSE_CODE = /\b([A-Z]{2,5}-\d{2,4}[A-Z]?)\b/;
const DAY_NAMES = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
} as const satisfies Record<string, string>;

/** The course code from the header WebReg puts just before a course's sections. */
function courseCodeFor(section: Element): string {
  const area = section.closest(".accordion-content-area");
  const header = area?.previousElementSibling;
  const text = header?.querySelector(".crsID")?.textContent ?? header?.textContent ?? "";
  return COURSE_CODE.exec(text)?.[1] ?? "";
}

/** Day codes like "MW", "TTh", "Sa"; [] for TBA or anything unrecognized (rather than guessing). */
function readDays(value: string | undefined): string[] {
  const names = new Map<string, string>(Object.entries(DAY_NAMES));
  try {
    return parseDays(value).map((code) => names.get(code) ?? "");
  } catch {
    return [];
  }
}

export function describeSection(section: Element): HoveredSection {
  const rows = sectionRows(section);
  const lines = sectionMeetingLines(rows);
  const meetings: SectionMeeting[] = [];
  let unreadable = lines === null;
  for (const line of lines ?? []) {
    let time: SectionMeeting["time"] | null = null;
    try {
      time = parseTimeRange(line.time);
    } catch {
      unreadable = true;
      continue;
    }
    const days = readDays(line.days).filter(Boolean);
    if (time && days.length > 0) {
      meetings.push({ days, time });
    } else if (time) {
      unreadable = true;
    }
  }
  return {
    course: courseCodeFor(section),
    name: sectionRowName(rows),
    type: sectionRowValue(rows, "Type"),
    meetings,
    unreadable,
  };
}

/** The course-page section an event happened in, ignoring anything outside WebReg's section lists. */
export function sectionAt(target: EventTarget | null): Element | null {
  // Not `instanceof Element`: a node can come from another realm (a frame, or the page vs. the content script).
  if (!target || !("closest" in target)) {
    return null;
  }
  // SAFETY: only DOM elements have closest(); text nodes, the document and window don't.
  const section = (target as Element).closest(".section");
  return section?.closest(".accordion-content-area") ? section : null;
}

/** Whether an event happened inside the week preview itself. */
function insidePreview(target: EventTarget | null) {
  // SAFETY: as in sectionAt, only elements have closest().
  return Boolean(target && "closest" in target && (target as Element).closest(".usc-helper-week-preview"));
}

/** How long the pointer has to rest on a row (or stay off all rows) before the preview changes. */
export const HOVER_DELAY_MS = 150;

/**
 * The section under the pointer, or else the one holding keyboard focus, after a short delay so sweeping the
 * mouse across the list doesn't flicker the calendar. The mouse and the keyboard are tracked separately, so
 * clicking text in one row doesn't drop the row the pointer is on. Moving onto the preview panel keeps
 * what it shows. `resetKey` (the page address) clears it on navigation.
 */
export function useHoveredSection(root: Document = document, resetKey = ""): HoveredSectionOnPage | null {
  const [hovered, setHovered] = useState<{ key: string; section: HoveredSectionOnPage } | null>(null);
  useEffect(() => {
    let pointed: Element | null = null;
    let focused: Element | null = null;
    let shown: Element | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const next = pointed ?? focused;
      clearTimeout(timer);
      timer = undefined;
      if (next === shown) {
        return;
      }
      timer = setTimeout(() => {
        shown = next;
        setHovered(next ? { key: resetKey, section: { ...describeSection(next), element: next } } : null);
      }, HOVER_DELAY_MS);
    };
    const onOver = (event: Event) => {
      if (insidePreview(event.target)) {
        return;
      }
      pointed = sectionAt(event.target);
      update();
    };
    // Where the pointer or focus went next; null when it left the window (or focus left the page).
    // SAFETY: relatedTarget on mouse and focus events is always an EventTarget or null.
    const nextTarget = (event: Event) =>
      "relatedTarget" in event ? (event.relatedTarget as EventTarget | null) : null;
    const onOut = (event: Event) => {
      if (nextTarget(event) === null) {
        pointed = null;
        update();
      }
    };
    const onFocusIn = (event: Event) => {
      if (insidePreview(event.target)) {
        return;
      }
      focused = sectionAt(event.target);
      update();
    };
    const onFocusOut = (event: Event) => {
      if (!sectionAt(nextTarget(event))) {
        focused = null;
        update();
      }
    };
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    return () => {
      clearTimeout(timer);
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
    };
  }, [root, resetKey]);
  return hovered?.key === resetKey ? hovered.section : null;
}
