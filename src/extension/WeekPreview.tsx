// Floating "Your week" calendar on WebReg course-search pages: a round button in the bottom-left corner that
// opens a small week view of your myCalendar classes. Styles are inline (and colors set on every text element)
// so WebReg's own CSS, including the extension's dark-mode stylesheet, doesn't restyle it.
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { CALENDAR_URL, loadSchedule, type ScheduleLoad } from "@/extension/scheduleSource";
import { useStorageItem, weekPreviewOpenStorage } from "@/extension/storage";
import { resolveTermIdentity } from "@/extension/uscTerms";
import { buildWeekGrid } from "@/extension/weekGrid";
import type { WeeklyMeeting } from "@/extension/weekSchedule";

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

const PX_PER_HOUR = 30;
const NO_MEETINGS: WeeklyMeeting[] = [];
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const CARDINAL = "#990000";
// Above WebReg's page and sticky nav, below MUI modals (1300) such as Notify Me and Final Exams.
const Z_INDEX = 1200;

interface Theme {
  surface: string;
  border: string;
  text: string;
  muted: string;
  note: string;
  gridLine: string;
  block: string;
  blockBorder: string;
  blockText: string;
  link: string;
  ring: string;
  focus: string;
  shadow: string;
}
// Non-text contrast (block borders, the button's ring) is at least 3:1 against what's behind it.
const LIGHT: Theme = {
  surface: "#ffffff",
  border: "#cfcfcf",
  text: "#222222",
  muted: "#595959",
  note: "#f3f3f3",
  gridLine: "#e6e6e6",
  block: "#e8edf5",
  blockBorder: "#6b7fa3",
  blockText: "#1f2a44",
  link: CARDINAL,
  ring: "#ffffff",
  focus: "#1f5fbf",
  shadow: "0 12px 32px rgba(0, 0, 0, 0.22)",
};
// Mirrors the --ush-* tokens in webregDark.css (see darkPalette.ts).
const DARK: Theme = {
  surface: "#161616",
  border: "#3d3d3d",
  text: "#e8e8ec",
  muted: "#9a9aa2",
  note: "#202020",
  gridLine: "#2a2a2a",
  block: "#1f2a3d",
  blockBorder: "#7a96cc",
  blockText: "#dce6f7",
  link: "#ff9a9a",
  ring: "#e8e8ec",
  focus: "#8fb4ff",
  shadow: "0 12px 32px rgba(0, 0, 0, 0.6)",
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

function CalendarIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
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

// A visible focus ring that a page rule like `*:focus { outline: none }` can't remove.
function FocusStyle({ color }: { color: string }) {
  return (
    <style>{`.usc-helper-week-preview :focus-visible, button.usc-helper-week-preview:focus-visible {
  outline: 3px solid ${color} !important;
  outline-offset: 2px !important;
}`}</style>
  );
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
  const grid = useMemo(() => buildWeekGrid(meetings, PX_PER_HOUR), [meetings]);
  const courseCount = new Set(meetings.map((m) => `${m.course} ${m.section}`)).size;
  const message = statusMessage(schedule);

  // `color` is set on every element that holds text, so page rules like `span { color }` can't reach in.
  const base: CSSProperties = { fontFamily: FONT, boxSizing: "border-box", margin: 0, letterSpacing: "normal" };
  const text = (color: string, extra: CSSProperties = {}): CSSProperties => ({ ...base, color, ...extra });

  if (!openLoaded) {
    return null;
  }

  if (!open) {
    return (
      <>
        <FocusStyle color={theme.focus} />
        <button
          type="button"
          className="usc-helper-week-preview"
          aria-label="Show your week"
          title="Show your week"
          ref={toggleRef}
          onClick={() => toggle(true)}
          style={{
            ...base,
            position: "fixed",
            left: 24,
            bottom: 24,
            zIndex: Z_INDEX,
            width: 56,
            height: 56,
            padding: 0,
            borderRadius: "50%",
            border: `3px solid ${theme.ring}`,
            background: CARDINAL,
            color: "#ffffff",
            boxShadow: theme.shadow,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <CalendarIcon size={24} />
        </button>
      </>
    );
  }

  const column = 100 / grid.days.length;
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
        left: 24,
        bottom: 24,
        zIndex: Z_INDEX,
        width: 300,
        maxHeight: "calc(100vh - 48px)",
        overflowY: "auto",
        padding: 0,
        background: theme.surface,
        color: theme.text,
        border: `1px solid ${theme.border}`,
        borderRadius: "14px 14px 14px 28px",
        boxShadow: theme.shadow,
        fontSize: 12,
        lineHeight: 1.4,
        textAlign: "left",
      }}
    >
      <FocusStyle color={theme.focus} />
      <div
        style={{
          ...base,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 10px 10px 12px",
          background: CARDINAL,
          color: "#ffffff",
          borderRadius: "13px 13px 0 0",
        }}
      >
        <CalendarIcon size={18} />
        <div style={{ ...base, flex: 1, minWidth: 0 }}>
          <div style={text("#ffffff", { fontSize: 13, fontWeight: 700 })}>Your week</div>
          <div style={text("#ffffff", { fontSize: 11 })}>
            {schedule.status === "ready"
              ? `${termName(schedule.termId) ?? "This term"} · ${courseCount} ${courseCount === 1 ? "class" : "classes"}`
              : "From myCalendar"}
          </div>
        </div>
        <button
          type="button"
          aria-label="Minimize your week"
          title="Minimize"
          ref={toggleRef}
          onClick={() => toggle(false)}
          style={{
            ...base,
            width: 32,
            height: 32,
            padding: 0,
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.7)",
            background: "transparent",
            color: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <svg
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
            style={{ width: 16, height: 16, display: "block" }}
          >
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>

      <div style={{ ...base, padding: "10px 12px 12px" }}>
        {/* Always present, so screen readers announce the text when it changes. */}
        <div
          role="status"
          style={
            message
              ? text(theme.text, { padding: "8px 10px", marginBottom: 10, borderRadius: 6, background: theme.note })
              : visuallyHidden
          }
        >
          {message}
        </div>

        {/* Mouse shortcut to myCalendar. Hidden from assistive tech; the list and the button below cover it. */}
        <div
          aria-hidden="true"
          title="Open myCalendar"
          onClick={() => window.location.assign(CALENDAR_URL)}
          style={{ ...base, cursor: "pointer" }}
        >
          <div style={{ ...base, display: "flex", gap: 4 }}>
            <div style={{ ...base, width: 24 }} />
            <div
              style={{
                ...base,
                flex: 1,
                display: "grid",
                gridTemplateColumns: `repeat(${grid.days.length}, minmax(0, 1fr))`,
                textAlign: "center",
              }}
            >
              {grid.shortDays.map((day) => (
                <span key={day} style={text(theme.muted, { fontSize: 10, fontWeight: 700 })}>
                  {day}
                </span>
              ))}
            </div>
          </div>
          <div style={{ ...base, display: "flex", gap: 4, marginTop: 3 }}>
            <div style={{ ...base, position: "relative", width: 24, height: grid.height }}>
              {grid.hourMarks
                .filter((mark) => (mark.hour - grid.startHour) % 2 === 0)
                .map((mark) => (
                  <span
                    key={mark.hour}
                    style={text(theme.muted, {
                      position: "absolute",
                      right: 0,
                      top: mark.top,
                      transform: "translateY(-50%)",
                      fontSize: 10,
                    })}
                  >
                    {mark.label}
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
                borderRadius: 4,
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
                const twoLines = block.height >= 24 && dash > 0;
                return (
                  <div
                    key={block.key}
                    data-course={block.course}
                    style={text(theme.blockText, {
                      position: "absolute",
                      left: `calc(${block.dayIndex * column + block.lane * laneWidth}% + 1px)`,
                      width: `calc(${laneWidth}% - 2px)`,
                      top: block.top,
                      height: Math.max(block.height - 1, 10),
                      background: theme.block,
                      border: `1px solid ${theme.blockBorder}`,
                      borderRadius: 3,
                      fontSize: 10,
                      fontWeight: 700,
                      lineHeight: 1.15,
                      padding: "2px 3px",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                    })}
                  >
                    {/* Subject over number ("MATH" / "407") so the number isn't cut off in a narrow column. */}
                    {twoLines ? (
                      <>
                        <span style={text(theme.blockText, { display: "block" })}>{block.course.slice(0, dash)}</span>
                        <span style={text(theme.blockText, { display: "block", fontWeight: 400 })}>
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

        {schedule.status === "ready" && grid.blocks.length > 0 ? (
          <ul aria-label="Your classes this week" style={visuallyHidden}>
            {grid.blocks.map((block) => (
              <li key={block.key}>{`${block.course}, ${grid.days[block.dayIndex]}, ${block.timeLabel}`}</li>
            ))}
          </ul>
        ) : null}

        <a
          href={CALENDAR_URL}
          style={text(theme.link, {
            marginTop: 10,
            height: 34,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            border: `1px solid ${theme.link}`,
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            textDecoration: "none",
          })}
        >
          Open myCalendar
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            style={{ width: 14, height: 14, display: "block" }}
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </a>
      </div>
    </section>
  );
}
