import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

// MATH-407 Tue/Thu 2:00–3:20 PM and CSCI-270 Mon/Wed 4:00–5:20 PM, as WebReg's calendar JSON (PST, UTC-8).
const ENTRIES = [
  { Title: "MATH-407 (39860R)", Start: "2027-02-02T14:00:00-08:00", End: "2027-02-02T15:20:00-08:00" },
  { Title: "MATH-407 (39860R)", Start: "2027-02-04T14:00:00-08:00", End: "2027-02-04T15:20:00-08:00" },
  { Title: "CSCI-270 (30040R)", Start: "2027-02-01T16:00:00-08:00", End: "2027-02-01T17:20:00-08:00" },
  { Title: "CSCI-270 (30040R)", Start: "2027-02-03T16:00:00-08:00", End: "2027-02-03T17:20:00-08:00" },
];
function calendarPage(termLabel: string, entries = ENTRIES) {
  const payload = JSON.stringify({ data: { Data: entries } });
  return `<html><body><a id="activeTermTab">${termLabel}</a><script>kendo.syncReady(${payload}\n})</script></body></html>`;
}

interface Stored {
  weekPreviewOpen?: boolean;
}

async function setUp() {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  // SAFETY: each named module is loaded for the exports listed in its type.
  const load = async <T,>(name: string) => (await import(pathToFileURL(resolveFromWxt.resolve(name)).href)) as T;
  const { parseHTML } = await load<{
    parseHTML: (html: string) => { document: Document; window: Window & typeof globalThis };
  }>("linkedom");
  const { fakeBrowser } = await load<{
    fakeBrowser: { reset(): void; storage: { local: { get(): Promise<Stored>; set(items: Stored): Promise<void> } } };
  }>("@webext-core/fake-browser");
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  const location = { href: "https://webreg.usc.edu/Courses?DeptId=CSCI", pathname: "/Courses" };
  Object.defineProperty(dom.window, "location", { configurable: true, value: location });
  Object.defineProperty(globalThis, "location", { configurable: true, value: location });
  // LinkeDOM doesn't track focus, so record which element was last focused.
  let lastFocused: Element | undefined;
  Object.defineProperty(dom.window.HTMLElement.prototype, "focus", {
    configurable: true,
    value(this: HTMLElement) {
      lastFocused = this;
    },
  });
  let calendar = calendarPage("Spring 2027 Classes");
  let fetches = 0;
  let held: (() => void)[] = [];
  let holdFetches = false;
  let ignoreAbort = false;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    DOMParser: dom.window.DOMParser,
    chrome: fakeBrowser,
    browser: fakeBrowser,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (_url: string, init?: RequestInit) => {
      fetches += 1;
      const body = calendar;
      if (holdFetches) {
        await new Promise<void>((resolve, reject) => {
          held.push(resolve);
          if (!ignoreAbort) {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      return new Response(body, { status: 200 });
    },
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WeekPreview } = await import("@/extension/WeekPreview");
  const source = await import("@/extension/scheduleSource");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
  const dispatch = (element: Element, type: string, props: { key?: string } = {}) =>
    element.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true }), props));

  const mount = async (
    t: test.TestContext,
    {
      stored = {},
      termLabel = "Spring 2027 Classes",
      darkMode = false,
      entries = ENTRIES,
      freshPage = true,
    }: { stored?: Stored; termLabel?: string; darkMode?: boolean; entries?: typeof ENTRIES; freshPage?: boolean } = {},
  ) => {
    fakeBrowser.reset();
    await fakeBrowser.storage.local.set(stored);
    if (freshPage) {
      // A real page load starts with no calendar loaded.
      source.resetScheduleLoad();
      fetches = 0;
    }
    calendar = calendarPage(termLabel, entries);
    dom.document.body.innerHTML = `<a id="activeTermTab">Spring 2027 Classes</a><div id="root"></div>`;
    const root = createRoot(dom.document.getElementById("root")!);
    const render = (props: { darkMode: boolean; href: string }) =>
      React.act(async () => root.render(React.createElement(WeekPreview, props)));
    await render({ darkMode, href: location.href });
    await React.act(settle);
    let mounted = true;
    const unmount = async () => {
      if (mounted) {
        mounted = false;
        await React.act(async () => root.unmount());
      }
    };
    // Unmount even when an assertion fails, so a leftover panel can't affect the next test.
    t.after(unmount);
    const q = (selector: string) => dom.document.querySelector<HTMLElement>(selector);
    return {
      q,
      render,
      act: async (fn: () => void) => {
        await React.act(async () => {
          fn();
          await settle();
        });
      },
      text: () => dom.document.getElementById("root")!.textContent ?? "",
      blocks: () => dom.document.querySelectorAll("[data-course]").length,
      stored: () => fakeBrowser.storage.local.get(),
      unmount,
    };
  };
  return {
    mount,
    source,
    dom,
    React,
    settle,
    dispatch,
    location,
    fetches: () => fetches,
    setCalendar: (termLabel: string) => {
      calendar = calendarPage(termLabel);
    },
    hold: (on: boolean, { ignoringAbort = false } = {}) => {
      holdFetches = on;
      ignoreAbort = ignoringAbort;
    },
    releaseHeld: () => {
      for (const resolve of held) {
        resolve();
      }
      held = [];
    },
    // Compared by identity; never hand DOM nodes to assert.equal (inspecting a LinkeDOM node hangs).
    focusedIs: (element: Element | null) => element !== null && lastFocused === element,
  };
}

const ready = setUp();

test("first visit: just a round calendar button with no badge, minimized", async (t) => {
  const { mount } = await ready;
  const page = await mount(t);
  const button = page.q('button[aria-label="Show your week"]')!;
  assert.ok(button);
  assert.equal(button.textContent, "", "no number or text on the button");
  assert.equal(page.q("section"), null);
});

test("clicking the button opens the calendar, remembers it, and moves focus to Minimize", async (t) => {
  const { mount, dispatch, focusedIs } = await ready;
  const page = await mount(t);
  await page.act(() => dispatch(page.q('button[aria-label="Show your week"]')!, "click"));
  assert.ok(page.q('section[aria-label="Your week"]'));
  assert.deepEqual(await page.stored(), { weekPreviewOpen: true });
  assert.ok(focusedIs(page.q('button[aria-label="Minimize your week"]')));
});

test("open, it shows this term's classes as blocks on the right days", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  assert.match(page.text(), /Spring 2027 · 2 classes/);
  const blocks = [...document.querySelectorAll("[data-course]")].map((b) => b.getAttribute("data-course"));
  assert.deepEqual(blocks.sort(), ["CSCI-270", "CSCI-270", "MATH-407", "MATH-407"]);
  // Screen readers get the same classes as a labelled list.
  assert.ok(page.q('ul[aria-label="Your classes this week"]'));
  assert.match(page.text(), /MATH-407, Tuesday, 2:00–3:20 PM/);
  assert.match(page.text(), /CSCI-270, Monday, 4:00–5:20 PM/);
});

test("there is exactly one link, Open myCalendar; the grid is a mouse shortcut hidden from assistive tech", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  const links = [...document.querySelectorAll("section a")];
  assert.equal(links.length, 1);
  assert.equal(links[0]!.getAttribute("href"), "https://webreg.usc.edu/Calendar");
  assert.equal(links[0]!.textContent, "Open myCalendar");
  const grid = page.q('[title="Open myCalendar"]')!;
  assert.equal(grid.getAttribute("aria-hidden"), "true");
  assert.equal(grid.getAttribute("tabindex"), null, "it can't take focus");
  assert.equal(grid.querySelector("a, button, [tabindex]"), null, "nothing inside it can take focus");
});

test("Escape minimizes (and isn't passed on to the page); other keys don't", async (t) => {
  const { mount, dispatch, focusedIs, dom } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  let pageSawKey = false;
  dom.document.body.addEventListener("keydown", () => (pageSawKey = true));
  await page.act(() => dispatch(page.q("section")!, "keydown", { key: "Tab" }));
  assert.ok(page.q("section"), "Tab keeps it open");
  pageSawKey = false;
  await page.act(() => dispatch(page.q("section")!, "keydown", { key: "Escape" }));
  assert.equal(page.q("section"), null);
  assert.equal(pageSawKey, false, "Escape stops at the panel");
  assert.deepEqual(await page.stored(), { weekPreviewOpen: false });
  assert.ok(focusedIs(page.q('button[aria-label="Show your week"]')));
});

test("the Minimize button goes back to the round button", async (t) => {
  const { mount, dispatch } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.act(() => dispatch(page.q('button[aria-label="Minimize your week"]')!, "click"));
  assert.ok(page.q('button[aria-label="Show your week"]'));
});

test("another tab switched terms: no classes, and it explains what to do (not 'reload')", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true }, termLabel: "Fall 2026 Classes" });
  assert.equal(page.blocks(), 0);
  assert.match(page.text(), /WebReg is now set to Fall 2026 \(changed in another tab\)\. Choose Spring 2027 again/);
  assert.doesNotMatch(page.text(), /[Rr]eload/);
});

test("a calendar page with no term (e.g. signed out) asks you to sign in, not about another tab", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true }, termLabel: "" });
  assert.match(page.text(), /Couldn't read your calendar\. If WebReg signed you out, sign in again\./);
  assert.doesNotMatch(page.text(), /another tab/);
});

test("every other status has its own message", async () => {
  const { statusMessage } = await import("@/extension/WeekPreview");
  assert.equal(statusMessage({ status: "loading" }), "Loading your calendar…");
  for (const reason of ["requestFailed", "unreadableCalendar"] as const) {
    assert.equal(
      statusMessage({ status: "unavailable", reason }),
      "Couldn't load your calendar from WebReg right now.",
    );
  }
  assert.equal(
    statusMessage({ status: "unavailable", reason: "unknownTabTerm" }),
    "Couldn't tell which term this page is for.",
  );
  assert.equal(
    statusMessage({ status: "ready", termId: "20271", schedule: { Data: [] }, meetings: [] }),
    "No classes on your calendar for this term yet.",
  );
});

test("the status line is always in the page, so screen readers announce changes to it", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  const status = page.q('[role="status"]')!;
  assert.ok(status);
  assert.equal(status.textContent, "", "nothing to say once the classes are shown");
});

test("panel first, then the Overlaps markers: one calendar request", async (t) => {
  const { mount, source, fetches } = await ready;
  await mount(t, { stored: { weekPreviewOpen: true } });
  await source.loadSchedule();
  assert.equal(fetches(), 1);
});

test("Overlaps markers first, then the panel in a later render: still one request", async (t) => {
  const { mount, source, fetches } = await ready;
  source.resetScheduleLoad();
  const before = fetches();
  const markers = source.loadSchedule();
  await mount(t, { stored: { weekPreviewOpen: true }, freshPage: false });
  await markers;
  assert.equal(fetches() - before, 1);
});

test("changing a setting (e.g. dark mode) keeps the classes on screen and doesn't refetch", async (t) => {
  const { mount, fetches, location } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.render({ darkMode: true, href: location.href });
  assert.equal(page.blocks(), 4);
  assert.doesNotMatch(page.text(), /Loading/);
  assert.equal(fetches(), 1);
});

test("after navigating, a late result from the previous page never replaces the new page's", async (t) => {
  const { mount, hold, releaseHeld, setCalendar, location, React, settle } = await ready;
  location.href = "https://webreg.usc.edu/Courses?DeptId=CSCI";
  t.after(() => {
    location.href = "https://webreg.usc.edu/Courses?DeptId=CSCI";
  });
  // The first page's response (another term) is already on its way back, and it arrives last.
  hold(true, { ignoringAbort: true });
  const page = await mount(t, { stored: { weekPreviewOpen: true }, termLabel: "Fall 2026 Classes" });
  assert.match(page.text(), /Loading your calendar/);
  hold(false);
  setCalendar("Spring 2027 Classes");
  location.href = "https://webreg.usc.edu/Courses?DeptId=MATH";
  await page.render({ darkMode: false, href: location.href });
  await React.act(settle);
  assert.equal(page.blocks(), 4, "the new page's calendar is shown");
  await React.act(async () => {
    releaseHeld();
    await settle();
  });
  assert.equal(page.blocks(), 4, "the late result was ignored");
  assert.doesNotMatch(page.text(), /another tab/);
});

test("right after navigating, the previous page's classes aren't shown as if they were the new page's", async (t) => {
  const { mount, hold, releaseHeld, location, React, settle } = await ready;
  location.href = "https://webreg.usc.edu/Courses?DeptId=CSCI";
  t.after(() => {
    hold(false);
    releaseHeld();
    location.href = "https://webreg.usc.edu/Courses?DeptId=CSCI";
  });
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  assert.equal(page.blocks(), 4);
  hold(true);
  location.href = "https://webreg.usc.edu/Courses?DeptId=MATH";
  await page.render({ darkMode: false, href: location.href });
  await React.act(settle);
  assert.equal(page.blocks(), 0);
  assert.match(page.text(), /Loading your calendar/);
});

test("dark mode: dark surface, and a light ring so the minimized button stands out on a dark page", async (t) => {
  const { mount, dispatch } = await ready;
  const page = await mount(t, { darkMode: true });
  assert.match(
    page.q('button[aria-label="Show your week"]')!.getAttribute("style") ?? "",
    /border:\s*3px solid (#e8e8ec|rgb\(232, 232, 236\))/i,
  );
  await page.act(() => dispatch(page.q('button[aria-label="Show your week"]')!, "click"));
  assert.match(page.q("section")!.getAttribute("style") ?? "", /background:\s*(#161616|rgb\(22, 22, 22\))/i);
});

test("every text element sets its own color, so page rules like `span { color }` can't restyle it", async (t) => {
  const { mount } = await ready;
  await mount(t, { stored: { weekPreviewOpen: true } });
  const uncolored = [...document.querySelectorAll("section span, section [data-course]")].filter(
    (el) => !/(^|;)\s*color:/.test(el.getAttribute("style") ?? ""),
  );
  assert.equal(uncolored.length, 0);
});

test("only WebReg course-search pages, only the top frame, only with the extension and setting on", async () => {
  const { shouldShowWeekPreview, isCourseSearchPage } = await import("@/extension/WeekPreview");
  const on = { enabled: true, showWeekPreview: true, topFrame: true };
  const shows = (href: string) => shouldShowWeekPreview({ ...on, href });
  assert.equal(shows("https://webreg.usc.edu/Courses?DeptId=CSCI"), true);
  assert.equal(shows("https://webreg.usc.edu/courses?DeptId=CSCI"), true);
  for (const href of [
    "https://webreg.usc.edu/CourseBin",
    "https://webreg.usc.edu/myCourseBin",
    "https://webreg.usc.edu/Calendar",
    "https://webreg.usc.edu/Departments",
    "https://webreg.usc.edu/Checkout",
    "https://classes.usc.edu/term/20271/courses/csci",
    "https://evil.example/Courses",
    "not a url",
  ]) {
    assert.equal(shows(href), false, href);
  }
  const course = "https://webreg.usc.edu/Courses?DeptId=CSCI";
  assert.equal(shouldShowWeekPreview({ ...on, href: course, enabled: false }), false);
  assert.equal(shouldShowWeekPreview({ ...on, href: course, showWeekPreview: false }), false);
  assert.equal(shouldShowWeekPreview({ ...on, href: course, topFrame: false }), false);
  assert.equal(isCourseSearchPage("https://webreg.usc.edu.evil.example/Courses"), false);
});

test("isTopFrame: the page itself yes; a same-origin or cross-origin frame no", async () => {
  const { isTopFrame } = await import("@/extension/WeekPreview");
  // SAFETY: isTopFrame only reads `top`; these stand-ins provide just that.
  const asWindow = (value: { top?: unknown }) => value as Window;
  const page = asWindow({});
  Object.assign(page, { top: page });
  assert.equal(isTopFrame(page), true);
  assert.equal(isTopFrame(asWindow({ top: page })), false);
  const crossOrigin = asWindow({});
  Object.defineProperty(crossOrigin, "top", {
    get() {
      throw new Error("SecurityError");
    },
  });
  assert.equal(isTopFrame(crossOrigin), false);
});
