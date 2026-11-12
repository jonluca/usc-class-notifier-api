// Floating "Your week" calendar on WebReg course-search pages: a round button in the bottom-left corner that
// opens a small week view of your myCalendar classes. Styles are inline (and colors set on every text element)
// so WebReg's own CSS, including the extension's dark-mode stylesheet, doesn't restyle it.
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { CALENDAR_URL, loadSchedule, type ScheduleLoad } from "@/extension/scheduleSource";
import { useStorageItem, weekPreviewOpenStorage } from "@/extension/storage";
import { resolveTermIdentity } from "@/extension/uscTerms";
import { type HoveredSection, useHoveredSection } from "@/extension/sectionHover";
import {
  type BlockKind,
  buildWeekGrid,
  formatTimeRange,
  type PreviewSummary,
  shortDayName,
} from "@/extension/weekGrid";
import type { MeetingStatus, WeeklyMeeting } from "@/extension/weekSchedule";

/** WebReg's course-search pages (department listings with sections), e.g. /Courses?DeptId=CSCI. */
export function isCourseSearchPage(href: string): boolean {
  try {
    const url = new URL(href);
    return url.hostname === "webreg.usc.edu" && url.pathname.toLowerCase().startsWith("/courses");
  } catch {
    return false;
  }
}

/** Only the page itself, never an iframe inside it (the content script also runs in frames). */
export function isTopFrame(win: Window = window): boolean {
  try {
    return win.top === win;
  } catch {
    // A cross-origin parent throws on access: we're in a frame.
    return false;
  }
}

/** Whether to show the panel at all: extension and setting on, a course-search page, and the page's top frame. */
export function shouldShowWeekPreview(state: {
  enabled: boolean;
  showWeekPreview: boolean;
  href: string;
  topFrame: boolean;
}): boolean {
  return state.enabled && state.showWeekPreview && state.topFrame && isCourseSearchPage(state.href);
}

type LoadState = { status: "loading" } | ScheduleLoad;

/**
 * The calendar for the page at `href`, shared with the Overlaps markers (one request per page and term,
 * whichever of the two asks first). It loads even while the panel is minimized, so opening it is instant.
 */
export function useSharedSchedule(href: string): LoadState {
  const [result, setResult] = useState<{ href: string; load: ScheduleLoad } | null>(null);
  useEffect(() => {
    let active = true;
    void loadSchedule().then((load) => {
      if (active) {
        setResult({ href, load });
      }
    });
    return () => {
      active = false;
    };
  }, [href]);
  // A result for a previous page counts as still loading the current one.
  return result?.href === href ? result.load : { status: "loading" };
}

const PX_PER_HOUR = 23;
const NO_MEETINGS: WeeklyMeeting[] = [];
const FONT = '"Fira Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
// Above WebReg's page and sticky nav, below MUI modals (1300) such as Notify Me and Final Exams.
const Z_INDEX = 1200;

/** Fill and text color for one kind of block. Blocks have no border: they're see-through tints, like WebReg. */
interface Tint {
  fill: string;
  text: string;
}
interface Theme {
  surface: string;
  /** WebReg's cardinal: used only for the frame (tab outline, top edge, link), never for class blocks. */
  frame: string;
  bar: string;
  text: string;
  muted: string;
  note: string;
  gridLine: string;
  /** myCalendar's own status colors, as tints: green Registered, gold Scheduled, red Conflict. */
  registered: Tint;
  scheduled: Tint;
  conflicted: Tint;
  other: Tint;
  /** Schedule Helper's own overlap color (the same as the peach Overlaps rows). */
  overlap: Tint;
  /** The hovered section: diagonal stripes, blue when it fits and orange when it overlaps. */
  previewFits: Tint;
  previewOverlap: Tint;
  /** Row outline colors (at least 3:1 against the page). */
  outlineFits: string;
  outlineOverlap: string;
  focus: string;
  shadow: string;
}
const stripes = (rgb: string, strong: number, weak: number) =>
  `repeating-linear-gradient(135deg, rgba(${rgb}, ${strong}) 0 5px, rgba(${rgb}, ${weak}) 5px 10px)`;
// Every block's text is checked against its fill: 6.4:1 or better in light and dark.
const LIGHT: Theme = {
  surface: "#ffffff",
  frame: "#990000",
  bar: "#f5f5f5",
  text: "#333333",
  muted: "#595959",
  note: "#f5f5f5",
  gridLine: "#e6e6e6",
  registered: { fill: "rgba(60, 167, 15, 0.22)", text: "#1d5207" },
  scheduled: { fill: "rgba(255, 204, 0, 0.30)", text: "#5c4700" },
  conflicted: { fill: "rgba(255, 0, 0, 0.14)", text: "#7a0000" },
  other: { fill: "rgba(0, 0, 0, 0.06)", text: "#333333" },
  overlap: { fill: "rgba(255, 134, 47, 0.37)", text: "#5a2a06" },
  previewFits: { fill: stripes("51, 122, 183", 0.28, 0.1), text: "#1f4a70" },
  previewOverlap: { fill: stripes("255, 134, 47", 0.3, 0.12), text: "#5a2a06" },
  outlineFits: "#337ab7",
  outlineOverlap: "#cc6a1f",
  focus: "#1f5fbf",
  shadow: "0 -2px 16px rgba(0, 0, 0, 0.14)",
};
// Mirrors the --ush-* surfaces in webregDark.css (see darkPalette.ts).
const DARK: Theme = {
  surface: "#161616",
  frame: "#ff9a9a",
  bar: "#202020",
  text: "#e8e8ec",
  muted: "#9a9aa2",
  note: "#202020",
  gridLine: "#2a2a2a",
  registered: { fill: "rgba(60, 167, 15, 0.30)", text: "#c4ecb0" },
  scheduled: { fill: "rgba(255, 204, 0, 0.24)", text: "#ffe48f" },
  conflicted: { fill: "rgba(255, 0, 0, 0.26)", text: "#ffc4c4" },
  other: { fill: "rgba(255, 255, 255, 0.08)", text: "#dddddd" },
  overlap: { fill: "rgba(255, 134, 47, 0.32)", text: "#ffd6b8" },
  previewFits: { fill: stripes("96, 150, 230", 0.36, 0.14), text: "#dbe8ff" },
  previewOverlap: { fill: stripes("255, 134, 47", 0.34, 0.14), text: "#ffd6b8" },
  outlineFits: "#7fb0e6",
  outlineOverlap: "#f08a4b",
  focus: "#8fb4ff",
  shadow: "0 -2px 16px rgba(0, 0, 0, 0.6)",
};

function termName(termId: string | undefined) {
  return termId ? resolveTermIdentity(termId)?.name.replace(/^USC /, "") : undefined;
}

export function statusMessage(state: LoadState): string | null {
  switch (state.status) {
    case "loading":
      return "Loading your calendar…";
    case "termMismatch": {
      if (!state.fetchedTermId) {
        // A login page, an error page, or WebReg's layout changed: either way we can't trust it.
        return "Couldn't read your calendar. If WebReg signed you out, sign in again.";
      }
      const now = termName(state.fetchedTermId) ?? "a different term";
      const here = termName(state.expectedTermId) ?? "this page's term";
      // WebReg keeps the selected term per session, so reloading this page would show the other term.
      return `WebReg is now set to ${now} (changed in another tab). Choose ${here} again to see its classes here.`;
    }
    case "unavailable":
      return state.reason === "unknownTabTerm"
        ? "Couldn't tell which term this page is for."
        : "Couldn't load your calendar from WebReg right now.";
    case "ready":
      return state.meetings.length === 0 ? "No classes on your calendar for this term yet." : null;
  }
}

function CalendarIcon({ size, color = "currentColor" }: { size: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ width: size, height: size, flex: "none", display: "block" }}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

/** Class on the WebReg section row being previewed; its data-preview-tone picks the outline color. */
export const PREVIEWED_ROW_CLASS = "usc-helper-previewed-row";

// A visible focus ring that a page rule like `*:focus { outline: none }` can't remove, and the outline on the
// previewed row. The row is marked with a class rather than its style attribute, because the Overlaps markers
// save and restore that attribute and could otherwise restore our outline after we've removed it.
function FocusStyle({ theme }: { theme: Theme }) {
  return (
    <style>{`.usc-helper-week-preview :focus-visible, button.usc-helper-week-preview:focus-visible {
  outline: 3px solid ${theme.focus} !important;
  outline-offset: 2px !important;
}
.${PREVIEWED_ROW_CLASS} {
  outline: 2px solid ${theme.muted} !important;
  outline-offset: -2px !important;
  border-radius: 3px;
}
.${PREVIEWED_ROW_CLASS}[data-preview-tone="fits"] { outline-color: ${theme.outlineFits} !important; }
.${PREVIEWED_ROW_CLASS}[data-preview-tone="overlaps"] { outline-color: ${theme.outlineOverlap} !important; }`}</style>
  );
}

const shortDays = (days: string[]) => days.map(shortDayName).join("/");

/** What the panel says about the hovered section; null when nothing is hovered. */
export function hoverMessage(
  hovered: HoveredSection | null,
  summary: PreviewSummary | undefined,
  scheduleReady: boolean,
): { text: string; tone: "fits" | "overlaps" | "neutral"; drawn: boolean } | null {
  if (!hovered) {
    return null;
  }
  const label = [hovered.course, hovered.type, hovered.name].filter(Boolean).join(" ");
  if (hovered.meetings.length === 0) {
    return {
      text: hovered.unreadable ? `${label}: couldn't read its meeting time.` : `${label}: no set meeting time.`,
      tone: "neutral",
      drawn: false,
    };
  }
  const when = hovered.meetings
    .map((m) => `${shortDays(m.days)} ${formatTimeRange(m.time.start, m.time.end)}`)
    .join(", ");
  if (!scheduleReady || !summary) {
    return {
      text: `${label} · ${when}. Can't check it against your calendar right now.`,
      tone: "neutral",
      drawn: false,
    };
  }
  if (summary.alreadyScheduled) {
    return { text: `${label} is already on your calendar.`, tone: "neutral", drawn: false };
  }
  if (summary.overlaps.length === 0) {
    return { text: `${label} · ${when} · Fits your week.`, tone: "fits", drawn: true };
  }
  const clashes = summary.overlaps
    .map((m) => `${m.course} (${shortDayName(m.day)} ${formatTimeRange(m.start, m.end)})`)
    .join(", ");
  return { text: `${label} · ${when} · Overlaps ${clashes}.`, tone: "overlaps", drawn: true };
}

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  margin: -1,
  padding: 0,
  border: 0,
};

export function WeekPreview({ darkMode, href }: { darkMode: boolean; href: string }) {
  const theme = darkMode ? DARK : LIGHT;
  const [open, setOpen, openLoaded] = useStorageItem(weekPreviewOpenStorage, false);
  // After the person opens or minimizes it, keep keyboard focus on the control that replaced the one they used.
  const focusAfterToggle = useRef(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusAfterToggle.current) {
      focusAfterToggle.current = false;
      toggleRef.current?.focus();
    }
  }, [open]);
  const toggle = (next: boolean) => {
    focusAfterToggle.current = true;
    void setOpen(next);
  };
  const schedule = useSharedSchedule(href);
  const meetings = schedule.status === "ready" ? schedule.meetings : NO_MEETINGS;
  const hovered = useHoveredSection(document, href);
  // Only compare against your calendar once it's loaded for this term; otherwise "fits" would be a guess.
  const scheduleReady = schedule.status === "ready";
  const preview = useMemo(
    () =>
      scheduleReady && hovered && hovered.meetings.length > 0
        ? { course: hovered.course, name: hovered.name, meetings: hovered.meetings }
        : undefined,
    [scheduleReady, hovered],
  );
  const grid = useMemo(() => buildWeekGrid(meetings, PX_PER_HOUR, preview), [meetings, preview]);
  const hoverStatus = hoverMessage(hovered, grid.preview, schedule.status === "ready");
  const courseCount = new Set(meetings.map((m) => `${m.course} ${m.section}`)).size;
  const message = statusMessage(schedule);

  // `color` is set on every element that holds text, so page rules like `span { color }` can't reach in.
  const base: CSSProperties = { fontFamily: FONT, boxSizing: "border-box", margin: 0, letterSpacing: "normal" };
  const text = (color: string, extra: CSSProperties = {}): CSSProperties => ({ ...base, color, ...extra });

  // Outline the row being previewed, in the same color as its result, so the row and the calendar line up.
  // WebReg's `.section` box has no height of its own (its Bootstrap columns float), so outline the
  // `.section-row` box inside it that the row is actually painted in; plain markup falls back to the section.
  const previewedRow = hovered
    ? (hovered.element.querySelector(":scope > .section-row") ?? hovered.element)
    : undefined;
  const rowTone = hoverStatus?.tone ?? "neutral";
  useEffect(() => {
    if (!previewedRow) {
      return;
    }
    previewedRow.classList.add(PREVIEWED_ROW_CLASS);
    previewedRow.setAttribute("data-preview-tone", rowTone);
    return () => {
      previewedRow.classList.remove(PREVIEWED_ROW_CLASS);
      previewedRow.removeAttribute("data-preview-tone");
    };
  }, [previewedRow, rowTone]);

  const blockLook = (kind: BlockKind, status?: MeetingStatus): Tint => {
    switch (kind) {
      case "scheduled":
        return status ? theme[status] : theme.scheduled;
      case "overlapped":
        return theme.overlap;
      case "preview":
        return theme.previewFits;
      case "previewOverlap":
        return theme.previewOverlap;
    }
  };

  if (!openLoaded) {
    return null;
  }

  // The tab on the window's bottom edge: a WebReg btn-default. It looks the same whatever you point at;
  // the row outline and the calendar show the result. Open, it sits on top of the drawer and closes it.
  const tab = (isOpen: boolean) => (
    <button
      type="button"
      className={isOpen ? undefined : "usc-helper-week-preview"}
      aria-expanded={isOpen}
      title={isOpen ? "Minimize" : "Show your week"}
      ref={toggleRef}
      onClick={() => toggle(!isOpen)}
      style={{
        ...base,
        position: isOpen ? "relative" : "fixed",
        left: isOpen ? undefined : 20,
        bottom: isOpen ? -1 : 0,
        zIndex: isOpen ? 1 : Z_INDEX,
        height: 32,
        padding: "0 12px",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        border: `1px solid ${theme.frame}`,
        borderBottom: isOpen ? `1px solid ${theme.surface}` : 0,
        borderRadius: "3px 3px 0 0",
        background: theme.surface,
        color: theme.text,
        fontSize: 13,
        cursor: "pointer",
        boxShadow: isOpen ? "none" : theme.shadow,
      }}
    >
      <CalendarIcon size={14} color={theme.frame} />
      <span style={text(theme.text)}>My Week</span>
      <span aria-hidden="true" style={text(theme.frame, { fontSize: 10 })}>
        {isOpen ? "▾" : "▴"}
      </span>
    </button>
  );

  if (!open) {
    return (
      <>
        <FocusStyle theme={theme} />
        {tab(false)}
      </>
    );
  }

  const column = 100 / grid.days.length;
  const statuses = new Set(meetings.map((m) => m.status));
  const legend: [string, Tint][] = [];
  if (statuses.has("registered")) {
    legend.push(["Registered", theme.registered]);
  }
  if (statuses.has("scheduled") || statuses.has(undefined)) {
    legend.push(["Scheduled", theme.scheduled]);
  }
  if (statuses.has("conflicted")) {
    legend.push(["Conflict", theme.conflicted]);
  }
  if (statuses.has("other")) {
    legend.push(["Other", theme.other]);
  }
  legend.push(["This section", theme.previewFits], ["Overlap", theme.overlap]);
  const GUTTER = 44;
  return (
    <section
      className="usc-helper-week-preview"
      aria-label="Your week"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          toggle(false);
        }
      }}
      style={{
        ...base,
        position: "fixed",
        left: 20,
        bottom: 0,
        zIndex: Z_INDEX,
        width: 330,
        color: theme.text,
        fontSize: 12,
        lineHeight: 1.4,
        textAlign: "left",
      }}
    >
      <FocusStyle theme={theme} />
      {tab(true)}
      <div
        data-testid="drawer-body"
        style={{
          ...base,
          background: theme.surface,
          border: `1px solid ${theme.frame}`,
          borderBottom: 0,
          boxShadow: theme.shadow,
          maxHeight: "calc(100vh - 44px)",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            ...base,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "6px 8px",
            background: theme.bar,
            borderBottom: `1px solid ${theme.gridLine}`,
          }}
        >
          <span style={text(theme.text, { fontSize: 12 })}>
            {schedule.status === "ready"
              ? `${termName(schedule.termId) ?? "This term"} · ${courseCount} ${courseCount === 1 ? "class" : "classes"}`
              : "From myCalendar"}
          </span>
          <a href={CALENDAR_URL} style={text(theme.frame, { fontSize: 12, textDecoration: "none" })}>
            Open myCalendar
            <span aria-hidden="true" style={text(theme.frame)}>
              {" "}
              ›
            </span>
          </a>
        </div>

        <div style={{ ...base, padding: 8 }}>
          {/* Always present, so screen readers announce the text when it changes. */}
          <div
            role="status"
            style={
              message
                ? text(theme.text, {
                    padding: "8px 10px",
                    marginBottom: 8,
                    background: theme.note,
                    border: `1px solid ${theme.gridLine}`,
                  })
                : visuallyHidden
            }
          >
            {message}
          </div>

          {/* Mouse shortcut to myCalendar. Hidden from assistive tech; the list and the link above cover it. */}
          <div
            aria-hidden="true"
            title="Open myCalendar"
            onClick={() => window.location.assign(CALENDAR_URL)}
            style={{ ...base, cursor: "pointer" }}
          >
            <div style={{ ...base, display: "flex" }}>
              <div style={{ ...base, width: GUTTER }} />
              <div
                style={{
                  ...base,
                  flex: 1,
                  display: "grid",
                  gridTemplateColumns: `repeat(${grid.days.length}, minmax(0, 1fr))`,
                  border: `1px solid ${theme.gridLine}`,
                  borderBottom: 0,
                  background: theme.bar,
                }}
              >
                {grid.shortDays.map((day, index) => (
                  <span
                    key={day}
                    style={text(theme.text, {
                      fontSize: 11,
                      fontWeight: 600,
                      textAlign: "center",
                      padding: "4px 0",
                      borderLeft: index === 0 ? 0 : `1px solid ${theme.gridLine}`,
                    })}
                  >
                    {day}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ ...base, display: "flex" }}>
              <div style={{ ...base, position: "relative", width: GUTTER, height: grid.height }}>
                {grid.hourMarks
                  .filter((mark) => (mark.hour - grid.startHour) % 2 === 0 && mark.hour < grid.endHour)
                  .map((mark) => (
                    <span
                      key={mark.hour}
                      style={text(theme.muted, { position: "absolute", right: 5, top: mark.top + 1, fontSize: 9 })}
                    >
                      {`${mark.hour % 12 || 12}:00 ${mark.hour % 24 < 12 ? "AM" : "PM"}`}
                    </span>
                  ))}
              </div>
              <div
                style={{
                  ...base,
                  flex: 1,
                  position: "relative",
                  height: grid.height,
                  border: `1px solid ${theme.gridLine}`,
                  overflow: "hidden",
                }}
              >
                {grid.hourMarks.map((mark) => (
                  <div
                    key={mark.hour}
                    style={{
                      ...base,
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: mark.top,
                      borderTop: `1px solid ${theme.gridLine}`,
                    }}
                  />
                ))}
                {grid.days.slice(1).map((day, index) => (
                  <div
                    key={day}
                    style={{
                      ...base,
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: `${(index + 1) * column}%`,
                      borderLeft: `1px solid ${theme.gridLine}`,
                    }}
                  />
                ))}
                {grid.blocks.map((block) => {
                  const laneWidth = column / block.lanes;
                  const dash = block.course.indexOf("-");
                  const twoLines = block.height >= 22 && dash > 0;
                  const look = blockLook(block.kind, block.status);
                  return (
                    <div
                      key={block.key}
                      data-course={block.course}
                      data-kind={block.kind}
                      data-status={block.status ?? ""}
                      style={text(look.text, {
                        position: "absolute",
                        left: `calc(${block.dayIndex * column + block.lane * laneWidth}% + 1px)`,
                        width: `calc(${laneWidth}% - 2px)`,
                        top: block.top + 1,
                        height: Math.max(block.height - 2, 10),
                        background: look.fill,
                        borderRadius: 3,
                        fontSize: 10,
                        fontWeight: 600,
                        lineHeight: 1.15,
                        padding: "2px 4px",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                      })}
                    >
                      {/* Subject over number ("MATH" / "407") so the number isn't cut off in a narrow column. */}
                      {twoLines ? (
                        <>
                          <span style={text(look.text, { display: "block" })}>{block.course.slice(0, dash)}</span>
                          <span style={text(look.text, { display: "block", fontWeight: 400 })}>
                            {block.course.slice(dash + 1)}
                          </span>
                        </>
                      ) : (
                        block.course
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/*
            The full result for screen readers, always present so each change is announced. Sighted users see the
            answer on the calendar and the row (outline, Overlaps button), so it isn't shown as text for them.
          */}
          <div aria-live="polite" data-testid="hover-status" style={visuallyHidden}>
            {hoverStatus?.text ?? ""}
          </div>
          {/* Shown only when nothing can be drawn, so an empty preview doesn't look like the extension broke. */}
          {hoverStatus && !hoverStatus.drawn ? (
            <div
              aria-hidden="true"
              data-testid="hover-note"
              style={text(theme.text, {
                marginTop: 8,
                padding: "8px 10px",
                fontSize: 12,
                background: theme.note,
                border: `1px solid ${theme.gridLine}`,
              })}
            >
              {hoverStatus.text}
            </div>
          ) : null}

          {schedule.status === "ready" && grid.blocks.length > 0 ? (
            <ul aria-label="Your classes this week" style={visuallyHidden}>
              {grid.blocks
                .filter((block) => block.kind === "scheduled" || block.kind === "overlapped")
                .map((block) => (
                  <li key={block.key}>{`${block.course}, ${grid.days[block.dayIndex]}, ${block.timeLabel}${
                    block.status === "registered"
                      ? ", registered"
                      : block.status === "conflicted"
                        ? ", conflict"
                        : block.status === "other"
                          ? ", other"
                          : ""
                  }`}</li>
                ))}
            </ul>
          ) : null}
        </div>

        {/* The legend explains the colors and hints that pointing at a section does something. */}
        <div
          aria-hidden="true"
          data-testid="legend"
          style={{
            ...base,
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 12px",
            padding: "6px 8px 8px",
            background: theme.bar,
            borderTop: `1px solid ${theme.gridLine}`,
          }}
        >
          {legend.map(([label, tint]) => (
            <span
              key={label}
              style={text(theme.muted, { display: "flex", alignItems: "center", gap: 5, fontSize: 10 })}
            >
              <span
                style={text(tint.text, {
                  display: "inline-block",
                  width: 14,
                  height: 10,
                  borderRadius: 2,
                  background: tint.fill,
                })}
              />
              {label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
