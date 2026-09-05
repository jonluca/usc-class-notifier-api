import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { scrapeRegisteredSections } from "@/extension/courseBinDom";

interface ServerDomParser {
  parseFromString(html: string, type: "text/html"): Document;
}

// WXT already uses LinkeDOM to parse extension HTML during builds. Resolve that existing
// server-side dependency from WXT so this regression test exercises a real detached document
// without adding a browser-only test environment to the application.
async function parseDetachedDocument(html: string): Promise<Document> {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  const linkedomPath = resolveFromWxt.resolve("linkedom");
  // SAFETY: LinkeDOM's documented module export is a constructable DOMParser with this method.
  const linkedom = (await import(pathToFileURL(linkedomPath).href)) as {
    DOMParser: new () => ServerDomParser;
  };
  return new linkedom.DOMParser().parseFromString(html, "text/html");
}

const COURSE_BIN_FIXTURE = `
  <span class="mycbstat">Registered section: <span class="courseBinStat">1</span>, Scheduled sections: 1</span>
  <div class="course-header">
    <span class="crsID">CSCI-104</span>
    <span class="crsTitl">Data Structures and Object Oriented Design</span>
  </div>
  <div class="accordion-content-area">
    <div id="section_12345" class="section">
      <div class="section_crsbin"></div>
      <div id="schedY_regN_12345" class="actionbar" style="display: none"></div>
      <div id="schedN_regN_12345" class="actionbar" style="display: none"></div>
      <div id="schedY_regY_12345" class="actionbar" style="display: block"></div>
      <div id="schedN_regY_12345" class="actionbar" style="display: none"></div>

      <span class="section_row">
        <span class="table-headers-xsmall">Session: </span>
        <a class="sessLnk" href="Courses?handler=SessionDatesPartial&amp;SessionId=133">133</a>
      </span>
      <span class="course-section-lecture section_row">
        <span class="table-headers-xsmall">Type: </span>
        Lecture
      </span>
      <span class="section_row">
        <span class="table-headers-xsmall">Time: </span>
        <span>10:00am-10:50am<br>02:00pm-03:50pm<br></span>
      </span>
      <span class="section_row">
        <span class="table-headers-xsmall">Days: </span>
        <span>MWF<br>Th<br></span>
      </span>
      <span class="section_row">
        <span class="table-headers-xsmall">Instructor: </span>
        <span>Ada Lovelace<br>Grace Hopper<br></span>
      </span>
      <span class="section_row">
        <span class="table-headers-xsmall">Location: </span>
        <span>THH101<br>KAP145<br></span>
      </span>
    </div>

    <div id="section_54321" class="section">
      <div class="section_crsbin"></div>
      <div id="schedY_regN_54321" class="actionbar" style="display: block"></div>
      <div id="schedN_regN_54321" class="actionbar" style="display: none"></div>
      <div id="schedY_regY_54321" class="actionbar" style="display: none"></div>
      <div id="schedN_regY_54321" class="actionbar" style="display: none"></div>
    </div>
  </div>
`;

test("scrapeRegisteredSections preserves br-separated meeting patterns in a detached document", async () => {
  const doc = await parseDetachedDocument(COURSE_BIN_FIXTURE);

  assert.deepEqual(scrapeRegisteredSections(doc), [
    {
      id: "12345",
      sessionId: "133",
      course: "CSCI 104",
      title: "Data Structures and Object Oriented Design",
      type: "Lecture",
      instructor: "Ada Lovelace; Grace Hopper",
      meetings: [
        {
          days: ["MO", "WE", "FR"],
          start: "10:00",
          end: "10:50",
          location: "101, Mark Taper Hall of Humanities",
        },
        {
          days: ["TH"],
          start: "14:00",
          end: "15:50",
          location: "145, Kaprielian Hall",
        },
      ],
    },
  ]);
});

test("scrapeRegisteredSections aborts instead of silently creating a partial export", async () => {
  const mismatchedRows = COURSE_BIN_FIXTURE.replace("MWF<br>Th<br>", "MWF<br>");
  const doc = await parseDetachedDocument(mismatchedRows);
  assert.throws(() => scrapeRegisteredSections(doc), /mismatched Time and Days rows/);
});

test("scrapeRegisteredSections rejects an unknown registration-state shape", async () => {
  const changedState = COURSE_BIN_FIXTURE.replace("schedY_regY_12345", "registered_12345");
  const doc = await parseDetachedDocument(changedState);
  assert.throws(() => scrapeRegisteredSections(doc), /unknown registration state/);
});

test("scrapeRegisteredSections accepts only explicit, internally consistent TBA meeting data", async () => {
  const oneSidedTba = COURSE_BIN_FIXTURE.replace("10:00am-10:50am", "TBA");
  const doc = await parseDetachedDocument(oneSidedTba);
  assert.throws(() => scrapeRegisteredSections(doc), /incomplete meeting data/);

  const allTba = COURSE_BIN_FIXTURE.replace("10:00am-10:50am<br>02:00pm-03:50pm<br>", "TBA<br>")
    .replace("MWF<br>Th<br>", "TBA<br>")
    .replace("THH101<br>KAP145<br>", "TBD<br>");
  const asyncSections = scrapeRegisteredSections(await parseDetachedDocument(allTba));
  assert.equal(asyncSections.length, 1);
  assert.deepEqual(asyncSections[0]?.meetings, []);
});

test("scrapeRegisteredSections rejects a login page or incomplete registered-section result", async () => {
  const loginPage = await parseDetachedDocument("<html><title>USC Login</title></html>");
  assert.throws(() => scrapeRegisteredSections(loginPage), /missing its registration summary/);

  const wrongSummary = COURSE_BIN_FIXTURE.replace('courseBinStat">1', 'courseBinStat">2');
  const doc = await parseDetachedDocument(wrongSummary);
  assert.throws(() => scrapeRegisteredSections(doc), /reported 2 registered sections, but 1 were parsed/);
});
