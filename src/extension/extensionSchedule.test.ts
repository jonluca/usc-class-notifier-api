// End-to-end through initExtension: a WebReg course page, a fetched /Calendar page, and the "Overlaps X" markers.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const COURSE_PAGE = `
  <ul class="nav"><li><a id="activeTermTab" href="#">Spring 2027 Classes</a></li></ul>
  <div><span class="course-title-indent">CSCI 104</span></div>
  <div class="accordion-content-area"><div class="section">
    <span class="section_row">Section: 30379R</span>
    <span class="section_row">Type: Lab</span>
    <span class="section_row">Days: Th</span>
    <span class="section_row">Time: 02:00pm-03:50pm</span>
    <button class="addtomycb">Add</button>
  </div></div>`;

// MATH-407 on Thursday 2:00–3:20 PM (PST is UTC-8 in February).
function calendarPage(termLabel: string) {
  const payload = JSON.stringify({
    data: { Data: [{ Title: "MATH-407 (39860R)", Start: "2027-02-04T22:00:00Z", End: "2027-02-04T23:20:00Z" }] },
  });
  return `<html><body><a id="activeTermTab">${termLabel}</a><script>kendo.syncReady(${payload}\n})</script></body></html>`;
}

async function setUp() {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  // SAFETY: each named module is loaded for the exports listed in its type.
  const load = async <T>(name: string) => (await import(pathToFileURL(resolveFromWxt.resolve(name)).href)) as T;
  const { parseHTML } = await load<{
    parseHTML: (html: string) => { document: Document; window: Window & typeof globalThis };
  }>("linkedom");
  const { fakeBrowser } = await load<{ fakeBrowser: object }>("@webext-core/fake-browser");
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.defineProperty(dom.window, "location", {
    configurable: true,
    value: { href: "https://webreg.usc.edu/Courses?DeptId=CSCI", pathname: "/Courses" },
  });
  // Browsers stringify elements as objects; LinkeDOM's markup strings confuse jQuery's array handling.
  Object.defineProperty(dom.window.HTMLElement.prototype, "toString", {
    configurable: true,
    value: () => "[object HTMLElement]",
  });
  let calendarResponse = calendarPage("Spring 2027 Classes");
  let fetchCount = 0;
  let delays: number[] = [];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    DOMParser: dom.window.DOMParser,
    chrome: fakeBrowser,
    browser: fakeBrowser,
    fetch: async (_url: string, init?: RequestInit) => {
      fetchCount += 1;
      const body = calendarResponse;
      const delay = delays.shift() ?? 0;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      return new Response(body, { status: 200 });
    },
  });
  // initExtension's own window.setTimeout/clearTimeout calls need the real timers.
  Object.assign(dom.window, { setTimeout, clearTimeout });
  const { initExtension } = await import("@/extension/extension");
  const run = async (options: { showConflicts: boolean }, calendarTerm = "Spring 2027 Classes") => {
    calendarResponse = calendarPage(calendarTerm);
    fetchCount = 0;
    dom.document.body.innerHTML = COURSE_PAGE;
    const cleanup = initExtension({ enabled: true, showUnits: false, darkMode: false, ...options });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const button = dom.document.querySelector("button.addtomycb")!;
    const result = { marked: button.classList.contains("warning"), text: button.textContent, fetches: fetchCount };
    cleanup();
    return result;
  };
  // Two initializations back to back (e.g. WebReg navigates while the first calendar request is slow).
  const runTwice = async (first: string, second: string) => {
    fetchCount = 0;
    delays = [40, 0];
    dom.document.body.innerHTML = COURSE_PAGE;
    const options = { enabled: true, showUnits: false, darkMode: false, showConflicts: true };
    calendarResponse = calendarPage(first);
    initExtension(options);
    calendarResponse = calendarPage(second);
    const cleanup = initExtension(options);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const button = dom.document.querySelector("button.addtomycb")!;
    const result = { marked: button.classList.contains("warning"), fetches: fetchCount };
    cleanup();
    return result;
  };
  return { run, runTwice };
}

const ready = setUp();

test("same term: the overlapping lab is marked", async () => {
  const { run } = await ready;
  const result = await run({ showConflicts: true });
  assert.deepEqual(result, { marked: true, text: "Overlaps MATH-407", fetches: 1 });
});

test("another tab switched WebReg to Fall: the Spring page marks nothing", async () => {
  const { run } = await ready;
  const result = await run({ showConflicts: true }, "Fall 2026 Classes");
  assert.deepEqual(result, { marked: false, text: "Add", fetches: 1 });
});

test("Show Class Conflicts off: the calendar isn't even fetched", async () => {
  const { run } = await ready;
  const result = await run({ showConflicts: false });
  assert.deepEqual(result, { marked: false, text: "Add", fetches: 0 });
});

test("a slow calendar from an earlier initialization is never applied after a newer one", async () => {
  const { runTwice } = await ready;
  // The first (slow) response would mark an overlap; the newer page's calendar is for another term.
  assert.deepEqual(await runTwice("Spring 2027 Classes", "Fall 2026 Classes"), { marked: false, fetches: 2 });
});
