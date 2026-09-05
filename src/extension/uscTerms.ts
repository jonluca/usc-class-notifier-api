import type { Holiday, Term } from "@/extension/ics";

const SEASONS = {
  "1": { name: "Spring", headingKind: "Semester" },
  "2": { name: "Summer", headingKind: "Session" },
  "3": { name: "Fall", headingKind: "Semester" },
} as const;

const MONTHS = new Map<string, number>(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((name, index) => [name, index + 1]),
);

interface TermIdentity {
  id: string;
  year: number;
  name: string;
  heading: string;
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function resolveTermIdentity(termId: string): TermIdentity | null {
  const match = termId.match(/^(\d{4})([123])$/);
  if (!match) {
    return null;
  }

  const seasonCode = match[2];
  if (seasonCode !== "1" && seasonCode !== "2" && seasonCode !== "3") {
    return null;
  }
  const season = SEASONS[seasonCode];

  const year = Number(match[1]);
  return {
    id: termId,
    year,
    name: `USC ${season.name} ${year}`,
    heading: `${season.name} ${season.headingKind} ${year}`,
  };
}

function validISODate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// USC publishes values such as "October 8-9" and, occasionally, cross-month ranges such as
// "December 17-January 10". Expand them here so the iCalendar generator can emit exact EXDATEs.
export function parseAcademicDateRange(value: string, year: number): string[] | null {
  const match = normalizedText(value).match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s*[-–—]\s*(?:([A-Za-z]+)\s+)?(\d{1,2}))?$/);
  if (!match) {
    return null;
  }

  const startMonth = MONTHS.get(match[1]!.toLowerCase());
  const endMonth = match[3] ? MONTHS.get(match[3].toLowerCase()) : startMonth;
  if (!startMonth || !endMonth) {
    return null;
  }

  const startDay = Number(match[2]);
  const endDay = Number(match[4] ?? match[2]);
  const endYear = endMonth < startMonth ? year + 1 : year;
  const startISO = validISODate(year, startMonth, startDay);
  const endISO = validISODate(endYear, endMonth, endDay);
  if (!startISO || !endISO || startISO > endISO) {
    return null;
  }

  const dates: string[] = [];
  for (
    let timestamp = Date.parse(`${startISO}T00:00:00Z`);
    timestamp <= Date.parse(`${endISO}T00:00:00Z`);
    timestamp += 86_400_000
  ) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
}

interface TermTable {
  element: HTMLTableElement;
  instructionalDays: number;
}

function findTermTable(doc: Document, headingText: string): TermTable | null {
  const heading = Array.from(doc.querySelectorAll("h2, h3")).find(
    (element) => normalizedText(element.textContent) === headingText,
  );
  if (!heading) {
    return null;
  }

  let instructionalDays: number | null = null;
  for (let element = heading.nextElementSibling; element; element = element.nextElementSibling) {
    const countMatch = normalizedText(element.textContent).match(/^(\d+) instructional days$/i);
    if (countMatch) {
      instructionalDays = Number(countMatch[1]);
    }
    if (element.tagName.toUpperCase() === "TABLE") {
      // SAFETY: tagName is the platform discriminator for an HTML table element.
      return instructionalDays === null ? null : { element: element as HTMLTableElement, instructionalDays };
    }
    if (/^(Fall|Spring) Semester \d{4}$|^Summer Session \d{4}$/.test(normalizedText(element.textContent))) {
      break;
    }
  }
  return null;
}

function countWeekdays(firstDay: string, lastDay: string): number {
  let count = 0;
  for (
    let timestamp = Date.parse(`${firstDay}T00:00:00Z`);
    timestamp <= Date.parse(`${lastDay}T00:00:00Z`);
    timestamp += 86_400_000
  ) {
    const day = new Date(timestamp).getUTCDay();
    if (day !== 0 && day !== 6) {
      count++;
    }
  }
  return count;
}

export function resolveTerm(termId: string, academicCalendar: Document): Term | null {
  const identity = resolveTermIdentity(termId);
  if (!identity) {
    return null;
  }

  const termTable = findTermTable(academicCalendar, identity.heading);
  if (!termTable) {
    return null;
  }

  const rows = Array.from(termTable.element.querySelectorAll("tr")).map((row) => {
    const cells = Array.from(row.querySelectorAll("td"));
    return {
      name: normalizedText(cells[0]?.textContent),
      dates: cells[2] ? parseAcademicDateRange(cells[2].textContent ?? "", identity.year) : null,
    };
  });
  const classesBeginIndex = rows.findIndex((row) => row.name.toLowerCase() === "classes begin");
  const classesEndIndex = rows.findIndex((row) => row.name.toLowerCase() === "classes end");
  if (classesBeginIndex < 0 || classesEndIndex <= classesBeginIndex) {
    return null;
  }

  const firstDay = rows[classesBeginIndex]?.dates?.[0];
  const lastDay = rows[classesEndIndex]?.dates?.at(-1);
  if (!firstDay || !lastDay || firstDay > lastDay) {
    return null;
  }

  const holidays: Holiday[] = [];
  for (const row of rows.slice(classesBeginIndex + 1, classesEndIndex)) {
    if (!row.name || !row.dates) {
      return null;
    }
    for (const date of row.dates) {
      if (date >= firstDay && date <= lastDay) {
        holidays.push({ date, name: row.name });
      }
    }
  }

  const excludedWeekdays = new Set(
    holidays
      .map((holiday) => holiday.date)
      .filter((date) => {
        const day = new Date(`${date}T00:00:00Z`).getUTCDay();
        return day !== 0 && day !== 6;
      }),
  );
  if (countWeekdays(firstDay, lastDay) - excludedWeekdays.size !== termTable.instructionalDays) {
    return null;
  }

  return {
    id: identity.id,
    name: identity.name,
    firstDay,
    lastDay,
    holidays,
  };
}
