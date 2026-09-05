import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseAcademicDateRange, resolveTerm, resolveTermIdentity } from "@/extension/uscTerms";

interface ServerDomParser {
  parseFromString(html: string, type: "text/html"): Document;
}

async function parseDocument(html: string): Promise<Document> {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  const linkedomPath = resolveFromWxt.resolve("linkedom");
  // SAFETY: LinkeDOM's documented module export is a constructable DOMParser with this method.
  const linkedom = (await import(pathToFileURL(linkedomPath).href)) as {
    DOMParser: new () => ServerDomParser;
  };
  return new linkedom.DOMParser().parseFromString(html, "text/html");
}

function row(name: string, weekday: string, dates: string): string {
  return `<tr><td><strong>${name}</strong></td><td>${weekday}</td><td>${dates}</td></tr>`;
}

const ACADEMIC_CALENDAR_FIXTURE = `
  <h3 class="wp-block-heading"><strong>Fall Semester 2026</strong></h3>
  <p class="is-style-lead-paragraph">68 instructional days</p>
  <table><tbody>
    ${row("Open Registration", "Mon-Fri", "August 17-21")}
    ${row("Classes Begin", "Mon", "August&nbsp;24")}
    ${row("Labor Day Holiday", "Mon", "September 7")}
    ${row("Fall Recess", "Thu-Fri", "October 8-9")}
    ${row("Veterans Day Holiday", "Wed", "November 11")}
    ${row("Thanksgiving Holiday", "Wed-Sun", "November 25-29")}
    ${row("Classes End", "Fri", "December 4")}
  </tbody></table>

  <h3 class="wp-block-heading"><strong>Spring Semester 2027</strong></h3>
  <p class="is-style-lead-paragraph">73 instructional days</p>
  <table><tbody>
    ${row("Classes Begin", "Mon", "January 11")}
    ${row("Martin Luther King’s Birthday", "Mon", "January 18")}
    ${row("President’s Day", "Mon", "February 15")}
    ${row("Spring Recess", "Sun-Sun", "March 14–21")}
    ${row("Classes End", "Fri", "April 30")}
  </tbody></table>

  <h3 class="wp-block-heading"><strong>Summer Session 2027</strong></h3>
  <p class="is-style-lead-paragraph">57 instructional days</p>
  <table><tbody>
    ${row("Classes Begin", "Wed", "May 19")}
    ${row("Memorial Day", "Mon", "May 31")}
    ${row("Juneteenth", "Fri", "June 18")}
    ${row("Independence Day", "Mon", "July 4-5")}
    ${row("Classes End", "Tue", "August 10")}
  </tbody></table>
`;

test("resolveTermIdentity derives any valid USC term without a year-specific lookup table", () => {
  assert.deepEqual(resolveTermIdentity("20313"), {
    id: "20313",
    year: 2031,
    name: "USC Fall 2031",
    heading: "Fall Semester 2031",
  });
  assert.equal(resolveTermIdentity("20310"), null);
  assert.equal(resolveTermIdentity("fall-2031"), null);
});

test("parseAcademicDateRange handles whitespace, Unicode dashes, and year rollover", () => {
  assert.deepEqual(parseAcademicDateRange("October\u00a08–9", 2026), ["2026-10-08", "2026-10-09"]);
  assert.deepEqual(parseAcademicDateRange("December 31-January 2", 2026), ["2026-12-31", "2027-01-01", "2027-01-02"]);
  assert.equal(parseAcademicDateRange("TBD", 2026), null);
  assert.equal(parseAcademicDateRange("February 30", 2026), null);
});

test("resolveTerm parses Fall, Spring, and Summer from USC's generic academic-calendar shape", async () => {
  const doc = await parseDocument(ACADEMIC_CALENDAR_FIXTURE);

  assert.deepEqual(resolveTerm("20263", doc), {
    id: "20263",
    name: "USC Fall 2026",
    firstDay: "2026-08-24",
    lastDay: "2026-12-04",
    holidays: [
      { date: "2026-09-07", name: "Labor Day Holiday" },
      { date: "2026-10-08", name: "Fall Recess" },
      { date: "2026-10-09", name: "Fall Recess" },
      { date: "2026-11-11", name: "Veterans Day Holiday" },
      { date: "2026-11-25", name: "Thanksgiving Holiday" },
      { date: "2026-11-26", name: "Thanksgiving Holiday" },
      { date: "2026-11-27", name: "Thanksgiving Holiday" },
      { date: "2026-11-28", name: "Thanksgiving Holiday" },
      { date: "2026-11-29", name: "Thanksgiving Holiday" },
    ],
  });
  assert.equal(resolveTerm("20271", doc)?.holidays?.length, 10);
  assert.equal(resolveTerm("20272", doc)?.holidays?.length, 4);
});

test("resolveTerm rejects incomplete or internally inconsistent academic calendar data", async () => {
  const wrongCount = ACADEMIC_CALENDAR_FIXTURE.replace("68 instructional days", "69 instructional days");
  assert.equal(resolveTerm("20263", await parseDocument(wrongCount)), null);

  const unparseableHoliday = ACADEMIC_CALENDAR_FIXTURE.replace("October 8-9", "TBD");
  assert.equal(resolveTerm("20263", await parseDocument(unparseableHoliday)), null);
  assert.equal(resolveTerm("20283", await parseDocument(ACADEMIC_CALENDAR_FIXTURE)), null);
});
