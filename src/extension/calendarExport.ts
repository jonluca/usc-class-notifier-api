// Calendar export orchestration for webreg.usc.edu/Calendar. WebReg supplies the student's
// registered sections and meeting patterns; USC's public catalog supplies the exact session
// boundaries; and USC's academic calendar supplies university-wide holidays. The export is
// deliberately all-or-nothing so missing or changed upstream data cannot create a plausible but
// incorrect calendar.

import $ from "jquery";
import { toast } from "react-toastify";
import { browser } from "wxt/browser";
import { scrapeRegisteredSections, type RawSection } from "@/extension/courseBinDom";
import { COURSE_BIN_URL } from "@/extension/courseBinScrape";
import { getCurrentTerm } from "@/extension/getCurrentTerm";
import { countExportableMeetings, generateICS, type Schedule, type Section } from "@/extension/ics";
import {
  LOAD_USC_CALENDAR_METADATA,
  calendarMetadataResponseSchema,
  type CalendarMetadataRequest,
} from "@/extension/uscCalendarMetadata";
import { resolveTerm, resolveTermIdentity } from "@/extension/uscTerms";

export const ICS_EXPORT_BUTTON_CLASS = "usc-helper-ics-export";

const OFFICIAL_EXPORT_URL = "https://my.usc.edu/ical/";
const COURSE_BIN_TIMEOUT_MS = 10_000;
const DOWNLOAD_URL_LIFETIME_MS = 1_000;
let exportInProgress = false;

function triggerDownload(icsText: string, filename: string) {
  const blob = new Blob([icsText], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}

function officialExportUrl(termId: string): string {
  const url = new URL(OFFICIAL_EXPORT_URL);
  url.searchParams.set("term", termId);
  return url.toString();
}

function hasMeetingTime(section: RawSection): boolean {
  return section.meetings.some((meeting) => Boolean(meeting.days.length && meeting.start && meeting.end));
}

function metadataRequest(termId: string, sections: RawSection[]): CalendarMetadataRequest {
  return {
    type: LOAD_USC_CALENDAR_METADATA,
    termId,
    sections: sections.map((section) => {
      if (!section.sessionId) {
        throw new Error(`WebReg did not identify the session for section ${section.id}.`);
      }
      return {
        id: section.id,
        course: section.course,
        sessionId: section.sessionId,
      };
    }),
  };
}

async function loadCourseBin(): Promise<RawSection[]> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), COURSE_BIN_TIMEOUT_MS);
  try {
    const response = await fetch(COURSE_BIN_URL, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`WebReg course-bin request failed with status ${response.status}.`);
    }

    const html = await response.text();
    const courseBinDoc = new DOMParser().parseFromString(html, "text/html");
    return scrapeRegisteredSections(courseBinDoc);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function buildSchedule(termId: string, sections: RawSection[]): Promise<Schedule> {
  const parsedResponse = calendarMetadataResponseSchema.safeParse(
    await browser.runtime.sendMessage(metadataRequest(termId, sections)),
  );
  if (!parsedResponse.success) {
    throw new Error("The extension returned malformed USC calendar metadata.");
  }
  const response = parsedResponse.data;
  if (!response.ok) {
    throw new Error(response.error);
  }

  const academicCalendar = new DOMParser().parseFromString(response.metadata.academicCalendarHtml, "text/html");
  const term = resolveTerm(termId, academicCalendar);
  if (!term) {
    throw new Error(`USC's academic calendar could not be validated for ${termId}.`);
  }

  const resolvedSections: Section[] = sections.map((section) => {
    const session = response.metadata.sessionsBySectionId[section.id];
    if (!session) {
      throw new Error(`USC returned no session dates for section ${section.id}.`);
    }
    if (session.firstDay > session.lastDay) {
      throw new Error(`USC returned implausible session dates for section ${section.id}.`);
    }
    return { ...section, session };
  });

  return { term, sections: resolvedSections };
}

function exportSuccessMessage(sectionCount: number, meetingCount: number, skippedCount: number): string {
  const classLabel = sectionCount === 1 ? "class" : "classes";
  const meetingLabel = meetingCount === 1 ? "meeting pattern" : "meeting patterns";
  const skipped =
    skippedCount > 0 ? ` Skipped ${skippedCount} class${skippedCount === 1 ? "" : "es"} without times.` : "";
  return `Exported ${meetingCount} ${meetingLabel} from ${sectionCount} ${classLabel}.${skipped}`;
}

async function handleExportClick(button: HTMLButtonElement) {
  if (exportInProgress) {
    return;
  }

  exportInProgress = true;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Preparing .ics…";

  let termId = "";
  try {
    termId = getCurrentTerm();
    if (!resolveTermIdentity(termId)) {
      toast.error("Couldn't determine the current USC term. Try reloading the page.");
      return;
    }

    const registeredSections = await loadCourseBin();
    if (registeredSections.length === 0) {
      toast.error("No registered classes were found to export.");
      return;
    }

    const timedSections = registeredSections.filter(hasMeetingTime);
    if (timedSections.length === 0) {
      toast.info("Your registered classes do not have meeting times to export.");
      return;
    }

    const schedule = await buildSchedule(termId, timedSections);
    const meetingCount = countExportableMeetings(schedule);
    if (meetingCount === 0) {
      toast.info("Your registered classes do not have meeting times to export.");
      return;
    }

    triggerDownload(generateICS(schedule), `${termId}-usc-schedule.ics`);
    toast.success(
      exportSuccessMessage(timedSections.length, meetingCount, registeredSections.length - timedSections.length),
    );
  } catch (error) {
    console.error("USC Schedule Helper could not generate a validated calendar export.", error);
    if (resolveTermIdentity(termId)) {
      toast.info("Enhanced export is unavailable. Opening USC's official calendar exporter.");
      window.location.assign(officialExportUrl(termId));
    } else {
      toast.error("Calendar export failed. Try reloading the page.");
    }
  } finally {
    exportInProgress = false;
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

export function insertCalendarExportButton() {
  const exportPdfButton = $("#export");
  if (exportPdfButton.length === 0) {
    return;
  }

  $(`.${ICS_EXPORT_BUTTON_CLASS}`).remove();
  exportPdfButton.after(
    `<button type="button" class="${ICS_EXPORT_BUTTON_CLASS} btn btn-default" style="margin-left: 8px;">Export as .ics</button>`,
  );
  $(`.${ICS_EXPORT_BUTTON_CLASS}`)
    .off("click.usc-helper-ics-export")
    .on("click.usc-helper-ics-export", function (this: HTMLButtonElement) {
      void handleExportClick(this);
    });
}
