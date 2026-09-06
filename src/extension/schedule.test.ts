import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseScheduleDocument } from "@/extension/scheduleDocument";

const calendarDocument = (status: string) => {
  const payload = {
    data: {
      Data: [
        {
          Title: "CSCI 104",
          Start: "2026-08-24T10:00:00",
          End: "2026-08-24T11:50:00",
          Status: status,
        },
      ],
    },
  };
  return `<script>kendo.syncReady(${JSON.stringify(payload)}${String.fromCharCode(10)}`;
};

for (const status of ["Registered", "Scheduled", "Conflicted", "Blocked"]) {
  test(`parses USC calendar entries with ${status} status`, () => {
    assert.deepEqual(parseScheduleDocument(calendarDocument(status)), {
      Data: [
        {
          Title: "CSCI 104",
          Start: "2026-08-24T10:00:00",
          End: "2026-08-24T11:50:00",
        },
      ],
    });
  });
}

test("rejects calendar entries without the fields conflict detection consumes", () => {
  const payload = {
    data: {
      Data: [{ Title: "CSCI 104", Start: "2026-08-24T10:00:00" }],
    },
  };
  const document = `<script>kendo.syncReady(${JSON.stringify(payload)}${String.fromCharCode(10)}`;

  assert.equal(parseScheduleDocument(document), null);
});

test("conflict markers use USC time ranges and Los Angeles calendar times", async (t) => {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  // SAFETY: LinkeDOM supplies the browser interfaces used by this detached-document test.
  const { parseHTML } = (await import(pathToFileURL(resolveFromWxt.resolve("linkedom")).href)) as {
    parseHTML: (html: string) => { document: Document; window: Window & typeof globalThis };
  };
  const dom = parseHTML("<html><body></body></html>");
  const globals = ["document", "window", "Element"] as const;
  const originalGlobals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { document: dom.document, window: dom.window, Element: dom.window.Element });
  Object.defineProperty(dom.window, "location", {
    configurable: true,
    value: { href: "https://webreg.usc.edu/Classes" },
  });
  // Browsers stringify elements as objects; LinkeDOM's markup strings confuse jQuery's array handling.
  // SAFETY: Element prototypes implement toString even though it is absent from the DOM interface's own keys.
  t.mock.method(
    dom.window.HTMLElement.prototype as HTMLElement & { toString(): string },
    "toString",
    () => "[object HTMLElement]",
  );
  const errors = t.mock.method(console, "error", () => {});
  const { parseSchedule } = await import("@/extension/schedule");
  t.after(() => {
    for (const [index, key] of globals.entries()) {
      const descriptor = originalGlobals[index];
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  });

  const cases = [
    {
      label: "afternoon range does not conflict with morning",
      time: "2:00-3:50pm",
      start: "16:00",
      end: "17:00",
      conflict: false,
    },
    { label: "afternoon overlap", time: "2:00-3:50pm", start: "21:00", end: "22:00", conflict: true },
    { label: "explicit afternoon meridiem", time: "02:00pm-03:50pm", start: "21:00", end: "22:00", conflict: true },
    { label: "noon crossing", time: "11:00-12:50pm", start: "19:00", end: "20:00", conflict: true },
    { label: "noon start", time: "12:00-1:50pm", start: "19:30", end: "20:00", conflict: true },
    { label: "midnight", time: "12:00am-12:50am", start: "07:00", end: "07:30", conflict: true },
    {
      label: "winter Los Angeles offset",
      time: "2:00-3:50pm",
      date: "2026-12-07",
      start: "22:00",
      end: "23:00",
      conflict: true,
    },
    {
      label: "Microsoft calendar dates",
      time: "2:00-3:50pm",
      microsoftDate: true,
      start: "21:00",
      end: "22:00",
      conflict: true,
    },
    {
      label: "candidate starts as registered class ends",
      time: "2:00-3:50pm",
      start: "20:00",
      end: "21:00",
      conflict: false,
    },
    {
      label: "candidate ends as registered class starts",
      time: "2:00-3:50pm",
      start: "22:50",
      end: "23:30",
      conflict: false,
    },
    { label: "TBA has no provable conflict", time: "TBA", start: "21:00", end: "22:00", conflict: false },
    {
      label: "invalid range has no provable conflict",
      time: "bad time",
      start: "21:00",
      end: "22:00",
      conflict: false,
    },
    {
      label: "reversed range has no provable conflict",
      time: "3:50pm-2:00pm",
      start: "21:00",
      end: "22:00",
      conflict: false,
    },
  ];
  for (const { label, time, date = "2026-08-24", microsoftDate = false, start, end, conflict } of cases) {
    dom.document.body.innerHTML = `<div><span class="course-title-indent">CSCI 170</span></div>
      <div class="accordion-content-area"><div class="section">
        <span class="section_row">Section: 67890R</span>
        <span class="section_row">Type: Lecture</span>
        <span class="section_row">Days: M</span>
        <span class="section_row">Time: ${time}</span>
        <button class="addtomycb">Add</button>
      </div></div>`;
    const startDate = `${date}T${start}:00Z`;
    const endDate = `${date}T${end}:00Z`;
    parseSchedule({
      Data: [
        {
          Title: "CSCI-104 (12345R)",
          Start: microsoftDate ? `/Date(${Date.parse(startDate)})/` : startDate,
          End: microsoftDate ? `/Date(${Date.parse(endDate)})/` : endDate,
        },
      ],
    });
    assert.equal(dom.document.querySelector("button")?.classList.contains("warning"), conflict, label);
    assert.equal(dom.document.querySelector(".course-title-indent")?.classList.contains("overlaps"), conflict, label);
  }
  assert.equal(errors.mock.callCount(), 2, "only malformed ranges are rejected");
});
