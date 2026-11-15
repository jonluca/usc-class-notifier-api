import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  CALENDAR_TIMEOUT_MS,
  createBrowserScheduleSourceDeps,
  fetchSchedule,
  loadSchedule,
  resetScheduleLoad,
  type ScheduleSourceDeps,
} from "@/extension/scheduleSource";

async function domParser() {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  // SAFETY: LinkeDOM's module export is a constructable DOMParser with parseFromString.
  const { DOMParser } = (await import(pathToFileURL(resolveFromWxt.resolve("linkedom")).href)) as {
    DOMParser: new () => { parseFromString(html: string, type: "text/html"): Document };
  };
  const parser = new DOMParser();
  return (html: string) => parser.parseFromString(html, "text/html");
}
const parseHtmlReady = domParser();

// The shape WebReg serves: a term tab in the nav, and the calendar's Kendo data on one script line.
function calendarHtml(
  termLabel: string | null,
  entries = [{ Title: "CSCI-270 (30040R)", Start: "2026-08-24T23:00:00Z", End: "2026-08-25T00:20:00Z" }],
) {
  const tab = termLabel === null ? "" : `<li><a id="activeTermTab" href="#">${termLabel}</a></li>`;
  const payload = JSON.stringify({ data: { Data: entries } });
  return `<html><body><ul class="nav">${tab}</ul><div id="scheduler"></div><script>kendo.syncReady(${payload}\n})</script></body></html>`;
}

async function deps(overrides: Partial<ScheduleSourceDeps> & { html?: string } = {}) {
  const parseHtml = await parseHtmlReady;
  let fetches = 0;
  const value: ScheduleSourceDeps = {
    pageHref: () => currentHref,
    currentTermId: () => "20271",
    fetchCalendarHtml: async () => {
      fetches += 1;
      return overrides.html ?? calendarHtml("Spring 2027 Classes");
    },
    parseHtml,
    ...overrides,
  };
  return { deps: value, fetches: () => fetches };
}

test("the calendar for the term this tab shows is ready, with weekly meetings", async () => {
  const { deps: d } = await deps();
  const result = await fetchSchedule(d);
  assert.equal(result.status, "ready");
  assert.equal(result.status === "ready" && result.termId, "20271");
  assert.deepEqual(result.status === "ready" && result.meetings, [
    { course: "CSCI-270", section: "30040", day: "Monday", start: "16:00", end: "17:20" },
  ]);
});

test("the term tab's real text on myCalendar (padded with newlines and spaces) is recognized", async () => {
  // Copied from WebReg's /Calendar page on 2026-11-11.
  const realLabel =
    "\n                                                    Spring 2027 Classes\n                                                    \n                                                ";
  const { deps: d } = await deps({ html: calendarHtml(realLabel) });
  assert.equal((await fetchSchedule(d)).status, "ready");
});

test("another tab switched WebReg to a different term: nothing is used", async () => {
  const { deps: d } = await deps({ html: calendarHtml("Fall 2026 Classes") });
  assert.deepEqual(await fetchSchedule(d), { status: "termMismatch", expectedTermId: "20271", fetchedTermId: "20263" });
});

test("a calendar page with no readable term is not trusted (e.g. a login page, or a renamed tab)", async () => {
  for (const html of [calendarHtml(null), calendarHtml("Choose a term"), "<html><body>Please sign in</body></html>"]) {
    const { deps: d } = await deps({ html });
    const result = await fetchSchedule(d);
    assert.equal(result.status, "termMismatch");
    assert.equal(result.status === "termMismatch" && result.fetchedTermId, undefined);
  }
});

test("if this tab's own term can't be told, nothing is fetched", async () => {
  const { deps: d, fetches } = await deps({ currentTermId: () => "" });
  assert.deepEqual(await fetchSchedule(d), { status: "unavailable", reason: "unknownTabTerm" });
  assert.equal(fetches(), 0);
});

test("the tab's term is read when the load starts, not when the response arrives", async () => {
  let term = "20271";
  let release: (html: string) => void = () => {};
  const { deps: d } = await deps({
    currentTermId: () => term,
    fetchCalendarHtml: () => new Promise((resolve) => (release = resolve)),
  });
  const result = fetchSchedule(d);
  term = "20263";
  release(calendarHtml("Spring 2027 Classes"));
  assert.equal((await result).status, "ready");
});

test("network errors, timeouts and WebReg error responses become 'unavailable', never a thrown error", async () => {
  const { deps: d } = await deps({ fetchCalendarHtml: () => Promise.reject(new Error("WebReg returned 500")) });
  assert.deepEqual(await fetchSchedule(d), { status: "unavailable", reason: "requestFailed" });
});

test("a right-term page whose calendar data can't be read is 'unavailable'", async () => {
  const { deps: d } = await deps({ html: `<a id="activeTermTab">Spring 2027 Classes</a><p>No calendar here</p>` });
  assert.deepEqual(await fetchSchedule(d), { status: "unavailable", reason: "unreadableCalendar" });
});

// loadSchedule keys its shared request by the page address and this tab's term.
let currentHref = "";
function at(href: string) {
  currentHref = href;
}

test("everything on a page shares one request, in any order, and nothing is fetched until something asks", async () => {
  resetScheduleLoad();
  at("https://webreg.usc.edu/Courses?DeptId=CSCI");
  const { deps: d, fetches } = await deps();
  assert.equal(fetches(), 0);
  const [first, second] = await Promise.all([loadSchedule(d), loadSchedule(d)]);
  assert.equal(fetches(), 1);
  assert.equal(first, second);
  await loadSchedule(d);
  assert.equal(fetches(), 1, "later callers on the same page (e.g. after a settings change) reuse it");
});

test("navigating to another page, or a different term in this tab, starts a new request and cancels the old one", async () => {
  resetScheduleLoad();
  at("https://webreg.usc.edu/Courses?DeptId=CSCI");
  let term = "20271";
  const signals: AbortSignal[] = [];
  const { deps: d } = await deps({
    currentTermId: () => term,
    fetchCalendarHtml: (signal) => {
      signals.push(signal);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  });
  void loadSchedule(d);
  at("https://webreg.usc.edu/Courses?DeptId=MATH");
  void loadSchedule(d);
  assert.equal(signals.length, 2);
  assert.equal(signals[0]!.aborted, true, "the old page's request is cancelled");
  term = "20263";
  void loadSchedule(d);
  assert.equal(signals.length, 3);
  assert.equal(signals[1]!.aborted, true);
  resetScheduleLoad();
  assert.equal(signals[2]!.aborted, true, "a reset cancels too");
});

test("a failed load isn't kept: the next caller on the page tries again, but a wrong-term answer is kept", async () => {
  resetScheduleLoad();
  at("https://webreg.usc.edu/Courses?DeptId=CSCI");
  let fail = true;
  let requests = 0;
  const { deps: d } = await deps({
    fetchCalendarHtml: () => {
      requests += 1;
      return fail
        ? Promise.reject(new Error("offline for a moment"))
        : Promise.resolve(calendarHtml("Spring 2027 Classes"));
    },
  });
  assert.equal((await loadSchedule(d)).status, "unavailable");
  fail = false;
  assert.equal((await loadSchedule(d)).status, "ready", "e.g. a settings change after the network came back");
  await loadSchedule(d);
  assert.equal(requests, 2, "a good load is still shared");

  resetScheduleLoad();
  const other = await deps({ html: calendarHtml("Fall 2026 Classes") });
  assert.equal((await loadSchedule(other.deps)).status, "termMismatch");
  await loadSchedule(other.deps);
  assert.equal(other.fetches(), 1, "retrying wouldn't change another tab's term");
});

test("an old page's failed load can't drop the newer page's load", async () => {
  resetScheduleLoad();
  at("https://webreg.usc.edu/Courses?DeptId=CSCI");
  let requests = 0;
  const { deps: d } = await deps({
    fetchCalendarHtml: (signal) => {
      requests += 1;
      return currentHref.endsWith("CSCI")
        ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
        : Promise.resolve(calendarHtml("Spring 2027 Classes"));
    },
  });
  const old = loadSchedule(d);
  at("https://webreg.usc.edu/Courses?DeptId=MATH");
  const current = loadSchedule(d);
  assert.equal((await old).status, "unavailable");
  assert.equal((await current).status, "ready");
  await loadSchedule(d);
  assert.equal(requests, 2, "the MATH page's load is still shared after the CSCI one failed");
});

test("a reset makes the next caller fetch again", async () => {
  resetScheduleLoad();
  at("https://webreg.usc.edu/Courses?DeptId=CSCI");
  const { deps: d, fetches } = await deps();
  await loadSchedule(d);
  resetScheduleLoad();
  await loadSchedule(d);
  assert.equal(fetches(), 2);
});

test("a cancelled request settles as unavailable instead of hanging or throwing", async () => {
  resetScheduleLoad();
  at("https://webreg.usc.edu/Courses?DeptId=CSCI");
  const { deps: d } = await deps({
    fetchCalendarHtml: (signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  const stale = loadSchedule(d);
  resetScheduleLoad();
  assert.deepEqual(await stale, { status: "unavailable", reason: "requestFailed" });
});

test("an unexpected error while checking the page is reported as unavailable, never thrown", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const { deps: d } = await deps({
    parseHtml: () => {
      throw new Error("parser exploded");
    },
  });
  assert.deepEqual(await fetchSchedule(d), { status: "unavailable", reason: "requestFailed" });
  assert.equal(errors.mock.callCount(), 1);
});

// The real fetch wrapper, with fetch itself replaced.
function withFetch(t: test.TestContext, respond: (signal: AbortSignal) => Promise<Response>) {
  const calls: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    calls.push(init.signal!);
    return respond(init.signal!);
  });
  return calls;
}
const hangUntilAborted = (signal: AbortSignal) =>
  new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));

test("browser fetch: a WebReg error status is a failed request, not a calendar", async (t) => {
  withFetch(t, async () => new Response(calendarHtml("Spring 2027 Classes"), { status: 500 }));
  const real = createBrowserScheduleSourceDeps();
  await assert.rejects(real.fetchCalendarHtml(new AbortController().signal), /500/);
  const parseHtml = await parseHtmlReady;
  assert.deepEqual(await fetchSchedule({ ...real, pageHref: () => "", currentTermId: () => "20271", parseHtml }), {
    status: "unavailable",
    reason: "requestFailed",
  });
});

test("browser fetch: a request that hangs is given up after the timeout", async (t) => {
  const calls = withFetch(t, hangUntilAborted);
  const real = createBrowserScheduleSourceDeps(20);
  const started = Date.now();
  await assert.rejects(real.fetchCalendarHtml(new AbortController().signal));
  assert.equal(calls[0]?.aborted, true);
  assert.ok(Date.now() - started < 2_000);
});

test("browser fetch: cancelling the load cancels the network request", async (t) => {
  const calls = withFetch(t, hangUntilAborted);
  const real = createBrowserScheduleSourceDeps(60_000);
  const controller = new AbortController();
  const started = Date.now();
  const request = real.fetchCalendarHtml(controller.signal);
  controller.abort();
  await assert.rejects(request);
  assert.equal(calls[0]?.aborted, true);
  assert.ok(Date.now() - started < 2_000, "cancelled right away, not by the timeout");
});

test("browser fetch: the default timeout is generous (the old fetch had none)", () => {
  // Registration rushes can make /Calendar slow; giving up too early would hide the markers entirely.
  assert.ok(CALENDAR_TIMEOUT_MS >= 30_000);
});
