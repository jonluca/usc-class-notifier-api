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
interface CalendarEntry {
  Title: string;
  Start: string;
  End: string;
  Status?: string;
}
function calendarPage(termLabel: string, entries: CalendarEntry[] = ENTRIES) {
  const payload = JSON.stringify({ data: { Data: entries } });
  return `<html><body><a id="activeTermTab">${termLabel}</a><script>kendo.syncReady(${payload}\n})</script></body></html>`;
}

// A course-search page's sections, as WebReg marks them up.
const sectionRow = (id: string, name: string, type: string, days: string, time: string) =>
  `<div class="section" id="${id}"><div class="col-xs-12 section-row" id="${id}-row">${Object.entries({
    Section: name,
    Type: type,
    Days: days,
    Time: time,
  })
    .map(
      ([label, value]) =>
        `<span class="section_row"><span class="hidden-lg hidden-md table-headers-xsmall">${label}: </span>${value}</span>`,
    )
    .join("")}<button class="addtomycb">Add</button></div></div>`;
const COURSE_SECTIONS = `<div class="course-header"><a class="course-title-indent">CSCI-104 L: Data Structures</a></div>
  <div class="accordion-content-area">
    ${sectionRow("fits", "30394 R", "Lab", "Th", "10:00am-10:50am")}
    ${sectionRow("clash", "30379 R", "Lab", "Th", "02:00pm-03:50pm")}
    ${sectionRow("tba", "29972 R", "Quiz", "", "TBA")}
    ${sectionRow("twice", "29980 R", "Lecture", "M<br>Th", "08:00am-09:20am<br>02:00pm-02:50pm")}
  </div>
  <div class="course-header"><a class="course-title-indent">MATH-407: Probability</a></div>
  <div class="accordion-content-area">${sectionRow("mine", "39860 R", "Lecture", "TTh", "02:00pm-03:20pm")}</div>`;

interface Stored {
  weekPreviewOpen?: boolean;
  weekPreviewSide?: "left" | "right";
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
  // A laptop-sized window unless a test resizes it.
  const resizeTo = (width: number, height: number) =>
    Object.assign(dom.window, { innerWidth: width, innerHeight: height });
  resizeTo(1300, 860);
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
    }: { stored?: Stored; termLabel?: string; darkMode?: boolean; entries?: CalendarEntry[]; freshPage?: boolean } = {},
  ) => {
    fakeBrowser.reset();
    await fakeBrowser.storage.local.set(stored);
    if (freshPage) {
      // A real page load starts with no calendar loaded.
      source.resetScheduleLoad();
      fetches = 0;
    }
    calendar = calendarPage(termLabel, entries);
    dom.document.body.innerHTML = `<a id="activeTermTab">Spring 2027 Classes</a>${COURSE_SECTIONS}<div id="root"></div>`;
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
    t.after(() => resizeTo(1300, 860));
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
      resize: async (width: number, height: number) => {
        await React.act(async () => {
          resizeTo(width, height);
          dom.window.dispatchEvent(new dom.window.Event("resize"));
          await settle();
        });
      },
      // Point at a section the way a mouse does, then wait out the hover delay.
      hover: async (id: string) => {
        await React.act(async () => {
          dom.document
            .querySelector(`#${id} span`)!
            .dispatchEvent(new dom.window.Event("mouseover", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 220));
        });
      },
      kinds: () =>
        [...dom.document.querySelectorAll("[data-kind]")]
          .map((b) => `${b.getAttribute("data-course")}:${b.getAttribute("data-kind")}`)
          .sort(),
      // Which row is outlined, and in which tone.
      outlined: () =>
        [...dom.document.querySelectorAll(".usc-helper-previewed-row")].map(
          (row) =>
            `${row.id.replace(/-row$/, "")}${row.id.endsWith("-row") ? "" : " (outer box)"}:${row.getAttribute("data-preview-tone")}`,
        ),
      pointAway: async () => {
        await React.act(async () => {
          dom.document
            .getElementById("activeTermTab")!
            .dispatchEvent(new dom.window.Event("mouseover", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 220));
        });
      },
      note: () => dom.document.querySelector('[data-testid="hover-note"]')?.textContent ?? null,
      hasLegend: () => dom.document.querySelector('[data-testid="legend"]') !== null,
      hoverStatus: () => dom.document.querySelector('[data-testid="hover-status"]')?.textContent ?? "",
      blocks: () => dom.document.querySelectorAll("[data-course]").length,
      stored: () => fakeBrowser.storage.local.get(),
      // Change a setting the way the popup does, while the page is open.
      store: async (items: Stored) => {
        await React.act(async () => {
          await fakeBrowser.storage.local.set(items);
          await settle();
        });
      },
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

test("first visit: just the My Week tab, with no badge or count, minimized", async (t) => {
  const { mount } = await ready;
  const page = await mount(t);
  const button = page.q('button[aria-expanded="false"]')!;
  assert.ok(button);
  assert.equal(button.textContent, "My Week▴");
  assert.equal(page.q("section"), null);
});

test("clicking the button opens the calendar, remembers it, and moves focus to Minimize", async (t) => {
  const { mount, dispatch, focusedIs } = await ready;
  const page = await mount(t);
  await page.act(() => dispatch(page.q('button[aria-expanded="false"]')!, "click"));
  assert.ok(page.q('section[aria-label="Your week"]'));
  assert.deepEqual(await page.stored(), { weekPreviewOpen: true });
  assert.ok(focusedIs(page.q('button[aria-expanded="true"]')));
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
  assert.equal(links[0]!.textContent, "Open myCalendar ›");
  assert.equal(links[0]!.querySelector("span")?.getAttribute("aria-hidden"), "true", "the arrow isn't read out");
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
  assert.ok(focusedIs(page.q('button[aria-expanded="false"]')));
});

test("the Minimize button goes back to the round button", async (t) => {
  const { mount, dispatch } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.act(() => dispatch(page.q('button[aria-expanded="true"]')!, "click"));
  assert.ok(page.q('button[aria-expanded="false"]'));
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

test("dark mode: dark drawer and tab, with the frame in a light red that's readable on dark", async (t) => {
  const { mount, dispatch } = await ready;
  const page = await mount(t, { darkMode: true });
  const tabStyle = page.q('button[aria-expanded="false"]')!.getAttribute("style") ?? "";
  assert.match(tabStyle, /background:\s*(#161616|rgb\(22, 22, 22\))/i);
  assert.match(tabStyle, /border:\s*1px solid (#ff9a9a|rgb\(255, 154, 154\))/i);
  await page.act(() => dispatch(page.q('button[aria-expanded="false"]')!, "click"));
  assert.match(
    page.q('[data-testid="drawer-body"]')!.getAttribute("style") ?? "",
    /background:\s*(#161616|rgb\(22, 22, 22\))/i,
  );
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

test("hovering a section that fits shows it as a preview and says it fits", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  assert.ok(page.hasLegend(), "the legend is there before you point at anything");
  await page.hover("fits");
  assert.ok(page.kinds().includes("CSCI-104:preview"));
  assert.equal(page.kinds().filter((k) => k.endsWith(":overlapped")).length, 0);
  assert.equal(page.hoverStatus(), "CSCI-104 Lab 30394R · Thu 10:00–10:50 AM · Fits your week.");
});

test("hovering a section that overlaps marks both classes and names the clash", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("clash");
  assert.ok(page.kinds().includes("CSCI-104:previewOverlap"));
  assert.ok(page.kinds().includes("MATH-407:overlapped"));
  assert.equal(page.kinds().filter((k) => k === "MATH-407:overlapped").length, 1, "only Thursday's MATH-407");
  assert.equal(page.hoverStatus(), "CSCI-104 Lab 30379R · Thu 2:00–3:50 PM · Overlaps MATH-407 (Thu 2:00–3:20 PM).");
});

test("a section with no set time, or one already on your calendar, is described but not drawn", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("tba");
  assert.equal(page.hoverStatus(), "CSCI-104 Quiz 29972R: no set meeting time.");
  assert.equal(page.kinds().filter((k) => k.includes("preview")).length, 0);
  await page.hover("mine");
  assert.equal(page.hoverStatus(), "MATH-407 Lecture 39860R is already on your calendar.");
  assert.equal(page.kinds().filter((k) => k.includes("preview")).length, 0);
});

test("when the calendar couldn't be checked (another term), hovering never claims a section fits", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true }, termLabel: "Fall 2026 Classes" });
  await page.hover("fits");
  assert.match(page.hoverStatus(), /Can't check it against your calendar right now\./);
  assert.doesNotMatch(page.hoverStatus(), /Fits/);
  assert.equal(page.kinds().length, 0);
});

for (const open of [false, true]) {
  test(`${open ? "open" : "minimized"}, the tab never changes when you point at a section`, async (t) => {
    const { mount } = await ready;
    const page = await mount(t, { stored: { weekPreviewOpen: open } });
    const tab = () => {
      const button = page.q(`button[aria-expanded="${open}"]`)!;
      return `${button.getAttribute("style")}|${button.textContent}`;
    };
    const atRest = tab();
    await page.hover("clash");
    assert.equal(tab(), atRest);
    assert.deepEqual(page.outlined(), ["clash:overlaps"]);
    await page.hover("fits");
    assert.equal(tab(), atRest);
  });
}

test("the screen-reader list of your classes doesn't include the hovered preview", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("clash");
  const items = [...document.querySelectorAll('ul[aria-label="Your classes this week"] li')].map(
    (li) => li.textContent,
  );
  assert.equal(items.length, 4);
  assert.ok(items.every((item) => !item?.startsWith("CSCI-104")));
});

test("a section with two meeting times shows both, and an overlap in either counts", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("twice");
  assert.equal(
    page.hoverStatus(),
    "CSCI-104 Lecture 29980R · Mon 8:00–9:20 AM, Thu 2:00–2:50 PM · Overlaps MATH-407 (Thu 2:00–3:20 PM).",
  );
  assert.ok(page.kinds().includes("CSCI-104:preview"), "Monday fits");
  assert.ok(page.kinds().includes("CSCI-104:previewOverlap"), "Thursday overlaps");
});

test("navigating to another page drops the previous page's hovered section", async (t) => {
  const { mount, location, React, settle } = await ready;
  t.after(() => {
    location.href = "https://webreg.usc.edu/Courses?DeptId=CSCI";
  });
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("fits");
  assert.match(page.hoverStatus(), /Fits your week/);
  location.href = "https://webreg.usc.edu/Courses?DeptId=MATH";
  await page.render({ darkMode: false, href: location.href });
  await React.act(settle);
  assert.equal(page.hoverStatus(), "");
});

test("the previewed row gets an outline in its result's color, and only one row at a time", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  assert.deepEqual(page.outlined(), []);
  await page.hover("fits");
  assert.deepEqual(page.outlined(), ["fits:fits"]);
  await page.hover("clash");
  assert.deepEqual(page.outlined(), ["clash:overlaps"]);
  await page.hover("tba");
  assert.deepEqual(page.outlined(), ["tba:neutral"]);
  await page.pointAway();
  assert.deepEqual(page.outlined(), []);
});

test("the outline also shows while the calendar is minimized", async (t) => {
  const { mount } = await ready;
  const page = await mount(t);
  await page.hover("clash");
  assert.deepEqual(page.outlined(), ["clash:overlaps"]);
});

test("the outline is removed when the panel goes away (setting off, navigation, extension off)", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("fits");
  await page.unmount();
  assert.deepEqual(page.outlined(), []);
  assert.equal(document.querySelectorAll("[data-preview-tone]").length, 0);
});

test("the outline never touches the row's style attribute (the Overlaps markers save and restore it)", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  const row = document.getElementById("clash")!;
  row.setAttribute("style", "background-color: peach");
  await page.hover("clash");
  assert.equal(row.getAttribute("style"), "background-color: peach");
  // The Overlaps cleanup restores the original style while the row is outlined: the outline stays correct.
  row.setAttribute("style", "");
  assert.deepEqual(page.outlined(), ["clash:overlaps"]);
  await page.pointAway();
  assert.deepEqual(page.outlined(), []);
  assert.equal(row.getAttribute("style"), "");
});

test("the outline's color updates when the calendar finishes loading after you hover", async (t) => {
  const { mount, hold, releaseHeld, React, settle } = await ready;
  t.after(() => {
    hold(false);
    releaseHeld();
  });
  hold(true);
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("fits");
  assert.deepEqual(page.outlined(), ["fits:neutral"]);
  hold(false);
  await React.act(async () => {
    releaseHeld();
    await settle();
  });
  assert.deepEqual(page.outlined(), ["fits:fits"]);
});

test("a fit or an overlap is shown on the calendar and the row only, with no text bar", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("fits");
  assert.equal(page.note(), null);
  await page.hover("clash");
  assert.equal(page.note(), null);
  assert.ok(page.hasLegend());
});

test("screen readers still hear the full result for a fit or an overlap", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("clash");
  const live = document.querySelector('[data-testid="hover-status"]')!;
  assert.equal(live.getAttribute("aria-live"), "polite");
  assert.match(live.textContent ?? "", /Overlaps MATH-407 \(Thu 2:00–3:20 PM\)/);
  assert.match(live.getAttribute("style") ?? "", /clip/, "visually hidden");
});

test("when nothing can be drawn, the bar explains why (and isn't announced twice)", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("tba");
  assert.equal(page.note(), "CSCI-104 Quiz 29972R: no set meeting time.");
  assert.equal(document.querySelector('[data-testid="hover-note"]')!.getAttribute("aria-hidden"), "true");
  await page.hover("mine");
  assert.equal(page.note(), "MATH-407 Lecture 39860R is already on your calendar.");
  await page.hover("fits");
  assert.equal(page.note(), null, "gone again once something is drawn");
});

test("the bar also explains when the calendar can't be checked", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true }, termLabel: "Fall 2026 Classes" });
  await page.hover("fits");
  assert.match(page.note() ?? "", /Can't check it against your calendar right now\./);
});

test("your classes are colored by their myCalendar status, with no borders", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, {
    stored: { weekPreviewOpen: true },
    entries: [
      {
        Title: "MATH-407 (39860R)",
        Start: "2027-02-02T14:00:00-08:00",
        End: "2027-02-02T15:20:00-08:00",
        Status: "Registered",
      },
      {
        Title: "CSCI-270 (30040R)",
        Start: "2027-02-01T16:00:00-08:00",
        End: "2027-02-01T17:20:00-08:00",
        Status: "Scheduled",
      },
      {
        Title: "EE-109 (31200R)",
        Start: "2027-02-03T09:00:00-08:00",
        End: "2027-02-03T09:50:00-08:00",
        Status: "Conflicted",
      },
    ],
  });
  const block = (course: string) => document.querySelector<HTMLElement>(`[data-course="${course}"]`)!;
  assert.equal(block("MATH-407").getAttribute("data-status"), "registered");
  assert.match(block("MATH-407").getAttribute("style") ?? "", /background:\s*rgba\(60, 167, 15, 0\.22\)/);
  assert.match(block("CSCI-270").getAttribute("style") ?? "", /background:\s*rgba\(255, 204, 0, 0\.30?\)/);
  assert.match(block("EE-109").getAttribute("style") ?? "", /background:\s*rgba\(255, 0, 0, 0\.14\)/);
  for (const course of ["MATH-407", "CSCI-270", "EE-109"]) {
    assert.doesNotMatch(
      block(course).getAttribute("style") ?? "",
      /border(-top|-right|-bottom|-left)?:/,
      `${course} has no border`,
    );
  }
  assert.equal(
    document.querySelector('[data-testid="legend"]')!.textContent,
    "RegisteredScheduledConflictThis sectionOverlap",
  );
  assert.match(page.text(), /MATH-407, Tuesday, 2:00–3:20 PM, registered/);
});

test("the legend only lists the statuses you actually have", async (t) => {
  const { mount } = await ready;
  const legend = () => document.querySelector('[data-testid="legend"]')!.textContent;
  await t.test("no statuses at all read as scheduled", async (t) => {
    await mount(t, { stored: { weekPreviewOpen: true } });
    assert.equal(legend(), "ScheduledThis sectionOverlap");
  });
  await t.test("only registered classes", async (t) => {
    await mount(t, {
      stored: { weekPreviewOpen: true },
      entries: [
        {
          Title: "MATH-407 (39860R)",
          Start: "2027-02-02T14:00:00-08:00",
          End: "2027-02-02T15:20:00-08:00",
          Status: "Registered",
        },
      ],
    });
    assert.equal(legend(), "RegisteredThis sectionOverlap");
  });
  await t.test("an empty week", async (t) => {
    await mount(t, { stored: { weekPreviewOpen: true }, entries: [] });
    assert.equal(legend(), "This sectionOverlap");
  });
  await t.test("a status myCalendar added later (Blocked) shows as Other", async (t) => {
    const page = await mount(t, {
      stored: { weekPreviewOpen: true },
      entries: [
        {
          Title: "MATH-407 (39860R)",
          Start: "2027-02-02T14:00:00-08:00",
          End: "2027-02-02T15:20:00-08:00",
          Status: "Blocked",
        },
      ],
    });
    assert.equal(legend(), "OtherThis sectionOverlap");
    assert.match(page.text(), /MATH-407, Tuesday, 2:00–3:20 PM, other/);
  });
});

test("the tab is named by what it says, and says whether the week is open", async (t) => {
  const { mount, dispatch } = await ready;
  const page = await mount(t);
  const tab = page.q("button[aria-expanded]")!;
  assert.equal(tab.getAttribute("aria-label"), null);
  assert.equal(tab.textContent?.replace(/[▴▾]/g, ""), "My Week");
  assert.equal(tab.getAttribute("aria-expanded"), "false");
  await page.act(() => dispatch(tab, "click"));
  assert.equal(page.q("button[aria-expanded]")!.getAttribute("aria-expanded"), "true");
});

test("fitDrawer keeps the drawer inside the window and at most about half its height", async () => {
  const { fitDrawer } = await import("@/extension/WeekPreview");
  // A normal laptop window gets the full-size drawer.
  assert.deepEqual(fitDrawer({ width: 1300, height: 860 }, 10), { width: 330, pxPerHour: 23, labelEvery: 2 });
  // A short window shrinks the hours so the drawer stays near half the window.
  assert.deepEqual(fitDrawer({ width: 1300, height: 600 }, 10), { width: 330, pxPerHour: 16, labelEvery: 2 });
  // Very short: stop at a readable minimum (the drawer scrolls) and label fewer hours so they don't collide.
  assert.deepEqual(fitDrawer({ width: 1300, height: 400 }, 10), { width: 330, pxPerHour: 12, labelEvery: 3 });
  // A long day (8 AM to 10 PM) gets less room per hour.
  assert.equal(fitDrawer({ width: 1300, height: 860 }, 14).pxPerHour, 20);
  // Narrow windows: 20px from each edge, but never narrower than 250px.
  assert.equal(fitDrawer({ width: 320, height: 860 }, 10).width, 280);
  assert.equal(fitDrawer({ width: 200, height: 860 }, 10).width, 250);
});

test("the open drawer resizes with the window", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  const section = () => page.q('section[aria-label="Your week"]')!.getAttribute("style") ?? "";
  const blockHeight = () => {
    const match = /height:\s*(\d+)px/.exec(page.q("[data-course]")!.getAttribute("style") ?? "");
    return Number(match?.[1]);
  };
  assert.match(section(), /width:\s*330px/);
  const fullHeight = blockHeight();
  await page.resize(300, 420);
  assert.match(section(), /width:\s*260px/);
  assert.ok(blockHeight() < fullHeight, `${blockHeight()} < ${fullHeight}`);
  await page.resize(1300, 860);
  assert.equal(blockHeight(), fullHeight);
});

test("the tab and drawer sit in the corner chosen in the popup: bottom-left by default, or bottom-right", async (t) => {
  const { mount, dispatch } = await ready;
  const anchoredTo = (style: string | null) =>
    /right:\s*20px/.test(style ?? "") ? "right" : /left:\s*20px/.test(style ?? "") ? "left" : "none";
  const check = async (t: test.TestContext, stored: Stored, side: "left" | "right") => {
    const page = await mount(t, { stored });
    assert.equal(anchoredTo(page.q('button[aria-expanded="false"]')!.getAttribute("style")), side, "closed tab");
    await page.act(() => dispatch(page.q('button[aria-expanded="false"]')!, "click"));
    assert.equal(anchoredTo(page.q('section[aria-label="Your week"]')!.getAttribute("style")), side, "drawer");
    // The open tab stays above the same corner instead of jumping across the drawer.
    assert.match(
      page.q('button[aria-expanded="true"]')!.parentElement!.getAttribute("style") ?? "",
      side === "right" ? /justify-content:\s*flex-end/ : /justify-content:\s*flex-start/,
    );
  };
  await t.test("never chosen", (t) => check(t, {}, "left"));
  await t.test("bottom-right", (t) => check(t, { weekPreviewSide: "right" }, "right"));
});

test("changing the corner in the popup moves an open drawer right away, keeping what it shows", async (t) => {
  const { mount } = await ready;
  const page = await mount(t, { stored: { weekPreviewOpen: true } });
  await page.hover("clash");
  const showing = page.hoverStatus();
  await page.store({ weekPreviewSide: "right" });
  assert.match(page.q('section[aria-label="Your week"]')!.getAttribute("style") ?? "", /right:\s*20px/);
  assert.equal(page.hoverStatus(), showing);
  await page.store({ weekPreviewSide: "left" });
  assert.match(page.q('section[aria-label="Your week"]')!.getAttribute("style") ?? "", /left:\s*20px/);
});
