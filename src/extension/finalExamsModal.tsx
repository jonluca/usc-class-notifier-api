// Tentative final-exam modal for /myCourseBin. View-only: nothing here touches the .ics export, and
// there is no conflict detection. Every render shows the "Tentative" banner.

import Modal from "@mui/material/Modal";
import { storage } from "@wxt-dev/storage";
import { useCallback, useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { scrapeCourseBinSections } from "@/extension/courseBinDom";
import { COURSE_BIN_URL } from "@/extension/courseBinScrape";
import { shouldEnableDarkMode } from "@/extension/darkMode";
import { darkPalette } from "@/extension/darkPalette";
import { closeFinalExamsModal } from "@/extension/finalExamsButton";
import { describeUnresolved, resolveFinalExams, type ExamEntry, type ExamSectionState } from "@/extension/finalExams";
import {
  BUNDLED_SOURCE_LABEL,
  loadFinalExamData,
  parseCacheEntry,
  type FinalExamsDataDependencies,
  type FinalExamsDataResult,
} from "@/extension/finalExamsData";
import {
  FINAL_EXAMS_PERMISSION_CHANGED_KEY,
  LOAD_FINAL_EXAMS_PAGE,
  OPEN_FINAL_EXAMS_PERMISSION,
  finalExamsPageResponseSchema,
} from "@/extension/finalExamsMessages";
import { FINAL_EXAM_SCHEDULE_URL, type ExamSlot } from "@/extension/finalExamsParse";
import { getCurrentTerm } from "@/extension/getCurrentTerm";
import { darkModeStorage, extensionEnabledStorage, useStorageItem } from "@/extension/storage";
import { resolveTermIdentity } from "@/extension/uscTerms";

const COURSE_BIN_TIMEOUT_MS = 10_000;

type ViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; termName: string; data: FinalExamsDataResult; entries: ExamEntry[]; sectionCount: number };

const browserDeps: FinalExamsDataDependencies = {
  now: () => Date.now(),
  readCache: async (key) => {
    // SAFETY: finalExamsCacheKey always produces a "local:" storage key.
    return parseCacheEntry(await storage.getItem(key as `local:${string}`));
  },
  writeCache: async (key, entry) => {
    // SAFETY: finalExamsCacheKey always produces a "local:" storage key.
    await storage.setItem(key as `local:${string}`, entry);
  },
  requestPage: async () =>
    finalExamsPageResponseSchema.parse(await browser.runtime.sendMessage({ type: LOAD_FINAL_EXAMS_PAGE })),
  parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
  warn: (message) => console.warn(message),
};

async function fetchCourseBin(): Promise<Document> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), COURSE_BIN_TIMEOUT_MS);
  try {
    const response = await fetch(COURSE_BIN_URL, { credentials: "same-origin", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`WebReg returned ${response.status} for your CourseBin.`);
    }
    return new DOMParser().parseFromString(await response.text(), "text/html");
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function loadView(forceRefresh: boolean): Promise<ViewState> {
  const termId = getCurrentTerm();
  const identity = resolveTermIdentity(termId);
  if (!identity) {
    return { kind: "error", message: "Couldn't tell which term this CourseBin is for. Try reloading the page." };
  }
  let sections;
  try {
    sections = scrapeCourseBinSections(await fetchCourseBin());
  } catch (error) {
    console.error("[USC Schedule Helper] final exams: couldn't read CourseBin.", error);
    return {
      kind: "error",
      message: "Couldn't read your CourseBin, so no exam list is shown (rather than a partial one).",
    };
  }
  const included = sections.filter((section) => section.state !== "bin");
  const data = await loadFinalExamData(termId, browserDeps, forceRefresh);
  const entries = data.status === "published" ? resolveFinalExams(included, data.data) : [];
  return { kind: "ready", termName: identity.name.replace(/^USC /, ""), data, entries, sectionCount: included.length };
}

function sortKey(entry: ExamEntry): string {
  const resolution = entry.resolution;
  if (resolution.kind === "grid" || resolution.kind === "exception") {
    return `${resolution.slot.date} ${resolution.slot.start} ${entry.course}`;
  }
  return entry.course;
}

const STATE_LABEL = {
  registered: "Registered",
  scheduled: "Scheduled",
  bin: "In bin",
} satisfies Record<ExamSectionState, string>;

const LONG_DATE = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const SHORT_STAMP = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const SHORT_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatClock(time: string): string {
  const [hourText = "0", minute = "00"] = time.split(":");
  const hour = Number(hourText);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}

// "2:00 – 4:00 PM", or "11:00 AM – 1:00 PM" when the range crosses noon.
function formatTimeRange(slot: ExamSlot): string {
  const start = formatClock(slot.start);
  const end = formatClock(slot.end);
  return start.slice(-2) === end.slice(-2) ? `${start.slice(0, -3)} – ${end}` : `${start} – ${end}`;
}

// "(Scheduled)", "(Registered)", or per-section labels when one course is split across entries.
function stateText(entry: ExamEntry, showIds: boolean): string {
  const labels = showIds
    ? entry.sections.map((section) => `${section.type || "Section"} ${section.id}, ${STATE_LABEL[section.state]}`)
    : [...new Set(entry.sections.map((section) => STATE_LABEL[section.state]))];
  return `(${labels.join("; ")})`;
}

interface Theme {
  bar: string;
  primary: string;
  muted: string;
  panel: string;
  divider: string;
  link: string;
  error: string;
}

function themeFor(darkMode: boolean): Theme {
  // Literal class strings (Tailwind scans source text). Colors use ! because WebReg's own CSS and
  // webregDark.css are unlayered and otherwise beat Tailwind's layered utilities.
  return darkMode
    ? {
        bar: "border-[#3d3d3d]", // --ush-border-strong
        primary: darkPalette.textPrimaryImportant,
        muted: darkPalette.textMutedImportant,
        panel: "bg-[#161616]!", // --ush-surface-raised
        divider: "border-[#2a2a2a]", // --ush-border
        link: "text-[#ff9a9a]! hover:text-[#ffb8b8]!", // --ush-link / --ush-link-hover
        error: "text-red-300!",
      }
    : {
        bar: "border-gray-300",
        primary: "text-gray-900!",
        muted: "text-gray-500!",
        panel: "bg-gray-100!",
        divider: "border-gray-200",
        link: "text-[#8b0000]!",
        error: "text-red-800!",
      };
}

function CourseLine({ entry, showIds, theme }: { entry: ExamEntry; showIds: boolean; theme: Theme }) {
  return (
    <div className={`text-[14px]! leading-[1.45]! mt-[2px]! ${theme.primary}`}>
      <span className="font-bold">{entry.course}</span> {entry.title}{" "}
      <span className={theme.muted}>
        {stateText(entry, showIds)}
        {entry.resolution.kind === "exception" ? " · dept. exception" : ""}
      </span>
    </div>
  );
}

function ExamList({ entries, theme }: { entries: ExamEntry[]; theme: Theme }) {
  const courseCounts = new Map<string, number>();
  for (const entry of entries) {
    courseCounts.set(entry.course, (courseCounts.get(entry.course) ?? 0) + 1);
  }
  const showIds = (entry: ExamEntry) => (courseCounts.get(entry.course) ?? 0) > 1;

  const timed = entries.filter((entry) => entry.resolution.kind === "grid" || entry.resolution.kind === "exception");
  const other = entries.filter((entry) => !timed.includes(entry));
  const days = new Map<string, ExamEntry[]>();
  for (const entry of timed) {
    const resolution = entry.resolution;
    if (resolution.kind === "grid" || resolution.kind === "exception") {
      days.set(resolution.slot.date, [...(days.get(resolution.slot.date) ?? []), entry]);
    }
  }

  return (
    <>
      {days.size > 0 && (
        <div className={`rounded-xl px-[18px]! py-[6px]! ${theme.panel}`}>
          {[...days].map(([date, dayEntries], dayIndex) => (
            <div key={date} className={`py-[14px]! ${dayIndex > 0 ? `border-t ${theme.divider}` : ""}`}>
              <div className={`font-bold text-[15px]! mb-[10px]! ${theme.primary}`}>
                {LONG_DATE.format(new Date(`${date}T00:00:00Z`))}
              </div>
              {dayEntries.map((entry, index) => {
                const resolution = entry.resolution;
                return (
                  <div
                    key={`${entry.course}-${index}`}
                    className={`border-l-[3px] pl-[12px]! py-[1px] ${theme.bar} ${index > 0 ? "mt-[14px]!" : ""}`}
                  >
                    {(resolution.kind === "grid" || resolution.kind === "exception") && (
                      <div className={`font-semibold text-[14px]! leading-[1.45]! ${theme.primary}`}>
                        {formatTimeRange(resolution.slot)}
                      </div>
                    )}
                    <CourseLine entry={entry} showIds={showIds(entry)} theme={theme} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {other.length > 0 && (
        <>
          <div className={`text-[12px]! font-bold uppercase tracking-wide mt-[16px]! mb-[4px]! ${theme.muted}`}>
            Couldn't determine
          </div>
          <div className={`rounded-xl px-[18px]! py-[6px]! ${theme.panel}`}>
            {other.map((entry, index) => (
              <div
                key={`${entry.course}-${index}`}
                className={`py-[14px]! ${index > 0 ? `border-t ${theme.divider}` : ""}`}
              >
                <div className={`border-l-[3px] pl-[12px]! py-[1px] ${theme.bar}`}>
                  <CourseLine entry={entry} showIds={showIds(entry)} theme={theme} />
                  <div
                    className={`text-[13px]! leading-[1.45]! mt-[2px]! ${entry.resolution.kind === "noExam" ? theme.muted : theme.error}`}
                  >
                    {entry.resolution.kind === "noExam"
                      ? "Session 061 has no scheduled final exam."
                      : describeUnresolved(entry.resolution)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

const FinalExamsModal = () => {
  const [darkModeSetting] = useStorageItem(darkModeStorage, false);
  const [extensionEnabled] = useStorageItem(extensionEnabledStorage, true);
  const darkMode = shouldEnableDarkMode({ enabled: extensionEnabled, darkMode: darkModeSetting });
  const theme = themeFor(darkMode);
  const [view, setView] = useState<ViewState>({ kind: "loading" });

  const reload = useCallback((forceRefresh: boolean) => {
    setView({ kind: "loading" });
    loadView(forceRefresh).then(setView, (error: Error) => setView({ kind: "error", message: error.message }));
  }, []);

  useEffect(() => {
    let active = true;
    // Initial state is already "loading", so the first load only sets state once it resolves.
    loadView(false).then(
      (next) => active && setView(next),
      (error: Error) => active && setView({ kind: "error", message: error.message }),
    );
    // The permission page writes this key after a grant; refetch live data when it does.
    const unwatch = storage.watch<number>(FINAL_EXAMS_PERMISSION_CHANGED_KEY, () => reload(true));
    return () => {
      active = false;
      unwatch();
    };
  }, [reload]);

  const requestPermission = () => {
    void browser.runtime.sendMessage({ type: OPEN_FINAL_EXAMS_PERMISSION });
  };

  const message = (text: React.ReactNode, tone: string = theme.primary) => (
    <div className={`rounded-xl px-[18px]! py-[16px]! text-[14px]! leading-[1.45]! ${theme.panel} ${tone}`}>{text}</div>
  );

  let body: React.ReactNode;
  if (view.kind === "loading") {
    body = message("Loading your CourseBin and the registrar's schedule…", theme.muted);
  } else if (view.kind === "error") {
    body = message(
      <>
        {view.message}{" "}
        <button
          type="button"
          className={`bg-transparent! border-0! p-0! underline cursor-pointer text-[14px]! ${theme.link}`}
          onClick={() => reload(false)}
        >
          Try again
        </button>
      </>,
      theme.error,
    );
  } else if (view.data.status === "unpublished") {
    body = message(
      `The registrar hasn't published a final exam schedule for ${view.termName} yet${
        view.data.checkedLive ? "." : " (as of the copy bundled with this extension)."
      }`,
    );
  } else if (view.sectionCount === 0) {
    body = message(`No registered or scheduled sections in your CourseBin for ${view.termName}.`);
  } else {
    body = <ExamList entries={[...view.entries].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))} theme={theme} />;
  }

  const data = view.kind === "ready" ? view.data : null;
  const linkButton = `bg-transparent! border-0! p-0! m-0! underline cursor-pointer text-[12px]! font-normal! ${theme.link}`;

  return (
    <Modal open={true} onClose={closeFinalExamsModal} style={{ outline: 0 }} disablePortal={true}>
      <div
        role="dialog"
        aria-labelledby="usc-helper-final-exams-title"
        className={`flex outline-hidden flex-col font-sans! w-full md:w-[520px] absolute bottom-0 md:bottom-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 px-[28px]! pt-[28px]! pb-[20px]! rounded-t-3xl md:rounded-2xl shadow-lg max-h-[90vh] overflow-y-auto ${
          darkMode ? `${darkPalette.bgSurface} border ${darkPalette.borderDefault}` : "bg-white"
        }`}
      >
        <div
          id="usc-helper-final-exams-title"
          className={`text-center text-[16px]! leading-[1.4]! font-normal mb-[18px]! ${theme.primary}`}
        >
          Final exams{view.kind === "ready" ? " for " : ""}
          {view.kind === "ready" && <span className="font-bold">{view.termName}</span>}*
        </div>

        {body}

        <div className="flex justify-end mt-[18px]!">
          <button
            type="button"
            className="rounded-lg! bg-[#8b0000]! border-0! text-white! text-[14px]! leading-[1.4]! font-bold! px-[14px]! py-[6px]! cursor-pointer"
            onClick={closeFinalExamsModal}
          >
            Close
          </button>
        </div>
        <div className={`text-center text-[12px]! leading-[1.45]! mt-[14px]! ${theme.muted}`}>
          * Tentative, based on the registrar's published schedule. Confirm exam times with your instructor.
        </div>
        <div className={`text-center text-[12px]! leading-[1.45]! mt-[6px]! ${theme.muted}`}>
          <a href={FINAL_EXAM_SCHEDULE_URL} target="_blank" rel="noreferrer" className={`underline ${theme.link}`}>
            Registrar's final exam schedule
          </a>
          {data?.status === "published" && data.fetchedAt !== null && (
            <> · last checked {SHORT_STAMP.format(new Date(data.fetchedAt))}</>
          )}
          {data?.status === "published" && data.fetchedAt === null && (
            <> · using the copy from {SHORT_DATE.format(new Date(`${BUNDLED_SOURCE_LABEL}T00:00:00Z`))}</>
          )}
          {data?.needsPermission && (
            <>
              {" · "}
              <button type="button" className={linkButton} onClick={requestPermission}>
                Allow live updates
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default FinalExamsModal;
