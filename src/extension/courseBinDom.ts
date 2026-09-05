// DOM adapter for /CourseBin — selectors, the part that rots when the page changes. Kept in
// its own file, separate from courseBinScrape.ts's pure parsers, so the string parsers remain
// independently testable and changes to USC's markup stay isolated here.
//
// Targets /CourseBin specifically: it's the only page carrying both the Time:/Days: rows and
// the registration-state divs (schedY_regY_{id} etc.) needed to tell an actually-registered
// section apart from one that's merely sitting in the course bin. The Calendar page's embedded
// Kendo JSON was a confirmed dead end for this — no term boundaries, no recurrence, only the
// server's default week.
//
// Reuses this repo's own confirmed markup idiom rather than the ScheduleHelper+ prototype's DOM
// adapter (written against a different, unverified capture): course groupings are
// `.accordion-content-area` panels whose header sits at `.prev()` — see
// src/extension/webRegPage.ts's addUnitsToTitle and src/extension/notify.ts's course-code
// lookup, both of which already rely on this shape in production.

import { parseDays, parseTimeRange, expandLocation } from "@/extension/courseBinScrape";

export interface RawMeeting {
  days: string[];
  start?: string;
  end?: string;
  location?: string;
}

export interface RawSection {
  id: string;
  sessionId?: string;
  course: string;
  title: string;
  type: string;
  instructor: string;
  meetings: RawMeeting[];
}

// Exactly one of a section's action-state divs (schedY_regN_{id}, schedN_regN_{id},
// schedY_regY_{id}, schedN_regY_{id}) has style="display: block" at a time; its id encodes the
// section's real Scheduled/Registered flags. A section belongs in the export iff Registered=Y,
// regardless of Scheduled: schedN_regY is still currently registered (a drop pending at the next
// Checkout submission — hasn't taken effect yet), while schedY_regN was only ever scheduled in
// the planner, never actually registered. Read directly off the id, not the human-readable text
// in the sibling status divs, which says the same thing but is a less stable signal to parse.
function registrationState(sectionEl: Element): boolean | null {
  const visibleStates: boolean[] = [];
  const actionbars = sectionEl.querySelectorAll<HTMLElement>(".actionbar");
  for (const el of actionbars) {
    if (el.style.display !== "block") {
      continue;
    }
    const match = el.id.match(/^sched[YN]_reg([YN])_/);
    if (match) {
      visibleStates.push(match[1] === "Y");
    }
  }
  return visibleStates.length === 1 ? visibleStates[0]! : null;
}

// DOMParser creates a detached document, so innerText does not reliably apply rendered <br>
// line breaks. Walk the DOM instead: preserve explicit <br>s and omit the responsive label.
// This keeps parallel Time/Days/Location values aligned even when the document has no layout.
function textWithBreaks(node: Node): string {
  if (node.nodeType === 3) {
    return node.textContent ?? "";
  }

  if (node.nodeType === 1) {
    // SAFETY: DOM nodeType 1 is the platform-defined discriminator for Element nodes.
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

function rowValueLines(row: Element): string[] {
  return textWithBreaks(row)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

function findRow(rows: Element[], label: string): Element | undefined {
  return rows.find((row) => {
    const rowLabel = row.querySelector(".table-headers-xsmall")?.textContent?.trim();
    return rowLabel?.replace(/:\s*$/, "").toLowerCase() === label.toLowerCase();
  });
}

function scrapeSessionId(sectionContainerEl: Element): string | undefined {
  const sessionLink = sectionContainerEl.querySelector(".sessLnk");
  const textId = sessionLink?.textContent?.match(/\b(\d{3})\b/)?.[1];
  if (textId) {
    return textId;
  }

  const href = sessionLink?.getAttribute("href") ?? "";
  const hrefId = href.match(/[?&]SessionId=([^&#]+)/i)?.[1];
  return hrefId
    ? decodeURIComponent(hrefId)
        .trim()
        .match(/^\d{3}$/)?.[0]
    : undefined;
}

function scrapeSection(sectionContainerEl: Element, course: string, title: string): RawSection {
  const id = sectionContainerEl.id.replace(/^section_/, "");
  const rows = Array.from(sectionContainerEl.querySelectorAll(".section_row"));

  const typeRow = findRow(rows, "Type");
  const timeRow = findRow(rows, "Time");
  const daysRow = findRow(rows, "Days");
  const locationRow = findRow(rows, "Location");
  const instructorRow = findRow(rows, "Instructor");

  const type = typeRow ? rowValueLines(typeRow).join(" ") : "";
  const instructor = instructorRow ? rowValueLines(instructorRow).join("; ") : "";

  if (!timeRow || !daysRow) {
    throw new Error(`Section ${id} is missing its Time or Days row.`);
  }
  const timeLines = rowValueLines(timeRow);
  const dayLines = rowValueLines(daysRow);
  const locationLines = locationRow ? rowValueLines(locationRow) : [];

  if (timeLines.length === 0 || timeLines.length !== dayLines.length) {
    throw new Error(`Section ${id} has mismatched Time and Days rows.`);
  }
  const patternCount = Math.max(timeLines.length, 1);
  if (locationLines.length > 1 && locationLines.length !== patternCount) {
    throw new Error(`Section ${id} has mismatched meeting locations.`);
  }

  const meetings: RawMeeting[] = [];
  for (let i = 0; i < patternCount; i++) {
    const rawDays = dayLines[i]!;
    const rawTime = timeLines[i]!;
    const daysUnavailable = /^(TBA|TBD)$/i.test(rawDays);
    const timeUnavailable = /^(TBA|TBD)$/i.test(rawTime);
    if (daysUnavailable && timeUnavailable) {
      continue;
    }
    if (daysUnavailable || timeUnavailable) {
      throw new Error(`Section ${id} has incomplete meeting data.`);
    }

    const days = parseDays(rawDays);
    const range = parseTimeRange(rawTime);
    if (days.length === 0 || !range) {
      throw new Error(`Section ${id} has incomplete meeting data.`);
    }
    const rawLocation = locationLines[i] ?? locationLines[0] ?? "";
    const location = rawLocation ? expandLocation(rawLocation) : undefined;
    meetings.push({ days, start: range.start, end: range.end, location });
  }

  return { id, sessionId: scrapeSessionId(sectionContainerEl), course, title, type, instructor, meetings };
}

function parseCourseHeader(headerEl: Element | undefined): { course: string; title: string } | null {
  if (!headerEl) {
    return null;
  }
  const crsIdText = headerEl.querySelector(".crsID")?.textContent?.trim() ?? "";
  const match = crsIdText.match(/^([A-Z]+)-(\d[\w]*)/i);
  if (!match) {
    return null;
  }
  const course = `${match[1]!.toUpperCase()} ${match[2]!.toUpperCase()}`;
  const title = headerEl.querySelector(".crsTitl")?.textContent?.trim() ?? "";
  return { course, title };
}

function expectedRegisteredSectionCount(doc: Document): number {
  const status = doc.querySelector(".mycbstat")?.textContent?.replace(/\s+/g, " ").trim();
  const match = status?.match(/Registered sections?:\s*(\d+)/i);
  if (!match) {
    throw new Error("WebReg course-bin markup is missing its registration summary.");
  }
  return Number(match[1]);
}

// Scrapes every actually-registered section out of a parsed /CourseBin document. Sections
// still sitting in the bin (never registered) and sections only scheduled-but-not-submitted are
// excluded. Parsing is intentionally strict: omitting a malformed registered section would make
// the downloaded calendar look complete when it is not, so markup drift aborts the enhanced
// export and lets its caller fall back to USC's official exporter.
export function scrapeRegisteredSections(doc: Document): RawSection[] {
  const expectedCount = expectedRegisteredSectionCount(doc);
  const sections: RawSection[] = [];

  for (const coursePanel of doc.querySelectorAll(".accordion-content-area")) {
    const sectionEls = coursePanel.querySelectorAll(".section_crsbin");
    if (sectionEls.length === 0) {
      throw new Error("WebReg course-bin markup contains an empty course panel.");
    }

    const header = parseCourseHeader(coursePanel.previousElementSibling ?? undefined);
    if (!header) {
      throw new Error("WebReg course-bin markup is missing a course header.");
    }

    for (const sectionEl of sectionEls) {
      const container = sectionEl.closest(".section");
      if (!container) {
        throw new Error("WebReg course-bin markup is missing a section container.");
      }

      const registered = registrationState(container);
      if (registered === null) {
        throw new Error(`WebReg course-bin markup has an unknown registration state for ${container.id}.`);
      }
      if (!registered) {
        continue;
      }

      sections.push(scrapeSection(container, header.course, header.title));
    }
  }

  if (sections.length !== expectedCount) {
    throw new Error(`WebReg reported ${expectedCount} registered sections, but ${sections.length} were parsed.`);
  }
  return sections;
}
