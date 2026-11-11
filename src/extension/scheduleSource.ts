// One load of your WebReg calendar (myCalendar) per page initialization, shared by the course-page "Overlaps X"
// markers and the week preview, and checked against the term this tab is showing.
//
// Why the term check: WebReg keeps the selected term on the server, per session. If another tab switches to a
// different term, this tab's fetch of /Calendar returns that other term's classes. Using them here would mark the
// wrong overlaps, so a mismatch shows nothing instead (the same rule as CourseBinTermError for Final Exams).
import { getCurrentTerm } from "@/extension/getCurrentTerm";
import { parseScheduleDocument, type Schedule } from "@/extension/scheduleDocument";
import { weeklyMeetings, type WeeklyMeeting } from "@/extension/weekSchedule";
import { parseSemesterTerm } from "@/utils/semester";

export const CALENDAR_URL = "https://webreg.usc.edu/Calendar";
// Generous on purpose: the old fetch had no limit, and /Calendar can be slow during registration rushes.
// The limit only exists so a hung request can't sit open for the life of the page.
export const CALENDAR_TIMEOUT_MS = 30_000;

export type ScheduleLoad =
  | { status: "ready"; termId: string; schedule: Schedule; meetings: WeeklyMeeting[] }
  /** The calendar came back for a different term than this tab shows (or for none we could read). */
  | { status: "termMismatch"; expectedTermId: string; fetchedTermId: string | undefined }
  | { status: "unavailable"; reason: "unknownTabTerm" | "requestFailed" | "unreadableCalendar" };

export interface ScheduleSourceDeps {
  /** The term this tab is showing, e.g. "20271"; "" when it can't be told. */
  currentTermId(): string;
  /** The /Calendar page's HTML. Rejects on network errors, timeouts, aborts and non-2xx responses. */
  fetchCalendarHtml(signal: AbortSignal): Promise<string>;
  parseHtml(html: string): Document;
}

export function createBrowserScheduleSourceDeps(timeoutMs = CALENDAR_TIMEOUT_MS): ScheduleSourceDeps {
  return {
    currentTermId: getCurrentTerm,
    async fetchCalendarHtml(signal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const timeoutId = setTimeout(abort, timeoutMs);
      try {
        const response = await fetch(CALENDAR_URL, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`WebReg returned ${response.status} for your calendar.`);
        }
        return await response.text();
      } finally {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", abort);
      }
    },
    parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
  };
}

export const browserScheduleSourceDeps = createBrowserScheduleSourceDeps();

/** Fetches and checks the calendar once. Never rejects: every failure is a ScheduleLoad status. */
export async function fetchSchedule(
  deps: ScheduleSourceDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<ScheduleLoad> {
  try {
    return await fetchAndCheck(deps, signal);
  } catch (error) {
    // Nothing above should throw, but callers rely on "never rejects", so keep the promise that way.
    console.error("[USC Schedule Helper] couldn't load your calendar.", error);
    return { status: "unavailable", reason: "requestFailed" };
  }
}

async function fetchAndCheck(deps: ScheduleSourceDeps, signal: AbortSignal): Promise<ScheduleLoad> {
  // Read before fetching, so the comparison is against the term this tab showed when it asked.
  const expectedTermId = deps.currentTermId();
  if (!expectedTermId) {
    return { status: "unavailable", reason: "unknownTabTerm" };
  }
  let html: string;
  try {
    html = await deps.fetchCalendarHtml(signal);
  } catch {
    // Offline, timed out or a WebReg error page: same outcome as before this module existed (nothing marked).
    return { status: "unavailable", reason: "requestFailed" };
  }
  const fetchedTermId = parseSemesterTerm(deps.parseHtml(html).getElementById("activeTermTab")?.textContent);
  if (fetchedTermId !== expectedTermId) {
    return { status: "termMismatch", expectedTermId, fetchedTermId };
  }
  const schedule = parseScheduleDocument(html);
  if (!schedule) {
    return { status: "unavailable", reason: "unreadableCalendar" };
  }
  return { status: "ready", termId: expectedTermId, schedule, meetings: weeklyMeetings(schedule) };
}

let pending: Promise<ScheduleLoad> | undefined;
let pendingController: AbortController | undefined;
let generation = 0;
const resetListeners = new Set<() => void>();

/**
 * The calendar for this page initialization. The first caller starts the request; later callers share it.
 * Nothing is fetched until someone asks, so with conflicts and the preview both off there is no request.
 */
export function loadSchedule(deps: ScheduleSourceDeps = browserScheduleSourceDeps): Promise<ScheduleLoad> {
  if (!pending) {
    pendingController = new AbortController();
    pending = fetchSchedule(deps, pendingController.signal);
  }
  return pending;
}

/**
 * Drops the shared load (new page, settings change, extension off) and cancels its request if still running.
 * The next loadSchedule() fetches again.
 */
export function resetScheduleLoad() {
  pendingController?.abort();
  pendingController = undefined;
  pending = undefined;
  generation += 1;
  for (const listener of resetListeners) {
    listener();
  }
}

/** Increases on every reset; compare before and after awaiting a load to ignore a result that arrived too late. */
export function scheduleLoadGeneration() {
  return generation;
}

/**
 * Called after each reset, e.g. so the preview can ask for the new page's calendar. Returns an unsubscribe.
 * Resets happen at the start of every initialization, before the extension's own on/off checks, so a listener
 * must check its own settings before calling loadSchedule() (or it would fetch while the extension is off).
 */
export function onScheduleLoadReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}
