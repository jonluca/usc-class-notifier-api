// Tests for the course-page "Overlaps X" markers. They started as characterization tests pinning what
// parseSchedule did before its parsing was shared with the week preview; the deliberate changes since
// (sections with several meeting times, values read from WebReg's hidden labels) have their own tests below.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Schedule } from "@/extension/scheduleDocument";

interface SectionSpec {
  /** Real WebReg markup: each label in a .table-headers-xsmall span, lines separated by <br>. */
  labelled?: boolean;
  section: string;
  type: string;
  days: string;
  time: string;
  button?: "add" | "notify" | "none";
}

interface CourseSpec {
  title: string;
  closed?: boolean;
  sections: SectionSpec[];
}

function sectionMarkup({ section, type, days, time, button = "add", labelled = false }: SectionSpec) {
  const buttonMarkup =
    button === "none"
      ? ""
      : button === "notify"
        ? `<button class="addtomycb notify" value="Notify Me">Notify Me</button>`
        : `<button class="addtomycb" value="Add">Add</button>`;
  const row = (label: string, value: string) =>
    labelled
      ? `<span class="section_row"><span class="hidden-lg hidden-md table-headers-xsmall">${label}: </span>${value}<br></span>`
      : `<span class="section_row">${label}: ${value}</span>`;
  return `<div class="section" data-section="${section}">
    ${row("Section", section)}
    ${row("Type", type)}
    ${row("Days", days)}
    ${row("Time", time)}
    ${buttonMarkup}
  </div>`;
}

function pageMarkup(courses: CourseSpec[]) {
  return courses
    .map(
      (course) => `<div><span class="course-title-indent${course.closed ? " closed" : ""}">${course.title}</span></div>
      <div class="accordion-content-area">${course.sections.map(sectionMarkup).join("")}</div>`,
    )
    .join("");
}

// One weekly meeting in USC local time on the week of 2026-08-24 (Mon) .. 2026-08-28 (Fri), expressed in
// UTC the way WebReg's calendar JSON is (PDT = UTC-7 in August).
const WEEKDAY_DATE = {
  M: "2026-08-24",
  T: "2026-08-25",
  W: "2026-08-26",
  Th: "2026-08-27",
  F: "2026-08-28",
} as const satisfies Record<string, string>;
function meeting(title: string, day: keyof typeof WEEKDAY_DATE, start: string, end: string, weekOffset = 0) {
  const toUtc = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    const date = new Date(`${WEEKDAY_DATE[day]}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + weekOffset * 7);
    date.setUTCHours(h! + 7, m!);
    return date.toISOString().replace(".000Z", "Z");
  };
  return { Title: title, Start: toUtc(start), End: toUtc(end) };
}

// jQuery binds to the window that exists when it is first imported, so the whole file shares one DOM.
let shared: Awaited<ReturnType<typeof createDom>> | undefined;
async function setUpDom(_t: test.TestContext) {
  shared ??= await createDom();
  return shared;
}

async function createDom() {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  // SAFETY: LinkeDOM supplies the browser interfaces used by this detached-document test.
  const { parseHTML } = (await import(pathToFileURL(resolveFromWxt.resolve("linkedom")).href)) as {
    parseHTML: (html: string) => { document: Document; window: Window & typeof globalThis };
  };
  const dom = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document: dom.document, window: dom.window, Element: dom.window.Element });
  Object.defineProperty(dom.window, "location", {
    configurable: true,
    value: { href: "https://webreg.usc.edu/Classes" },
  });
  // Browsers stringify elements as objects; LinkeDOM's markup strings confuse jQuery's array handling.
  // SAFETY: Element prototypes implement toString even though it is absent from the DOM interface's own keys.
  Object.defineProperty(dom.window.HTMLElement.prototype, "toString", {
    configurable: true,
    value: () => "[object HTMLElement]",
  });
  // LinkeDOM has no layout, so innerText (which parseSchedule reads) falls back to textContent here.
  if (!("innerText" in dom.window.HTMLElement.prototype)) {
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent ?? "";
      },
    });
  }
  const { parseSchedule } = await import("@/extension/schedule");
  const { default: $ } = await import("jquery");
  const run = (courses: CourseSpec[], schedule: Schedule | null, prepare?: (doc: Document) => void) => {
    dom.document.body.innerHTML = pageMarkup(courses);
    prepare?.(dom.document);
    // SAFETY: parseSchedule's own guard handles a null schedule; its signature just doesn't say so.
    parseSchedule(schedule as Schedule);
  };
  const button = (section: string) =>
    dom.document.querySelector<HTMLElement>(`[data-section="${section}"] button`) ?? undefined;
  const title = (index = 0) => dom.document.querySelectorAll<HTMLElement>(".course-title-indent")[index]!;
  return { dom, run, button, title, $ };
}

const LECTURE_MW_10 = { section: "29902R", type: "Lecture", days: "MW", time: "10:00-11:20am" };
const LECTURE_TTH_1230 = { section: "29901R", type: "Lecture", days: "TTh", time: "12:30-1:50pm" };
const LAB_F_12 = { section: "29910R", type: "Lab", days: "F", time: "12:00-1:50pm" };

test("labels the first conflicting class, in calendar order, and writes every button attribute", async (t) => {
  const { run, button } = await setUpDom(t);
  run([{ title: "CSCI 201", sections: [LECTURE_MW_10] }], {
    Data: [meeting("WRIT-340 (66700R)", "M", "10:00", "11:50"), meeting("MATH-226 (39600R)", "M", "11:00", "11:50")],
  });
  const add = button("29902R")!;
  assert.equal(add.textContent, "Overlaps WRIT-340");
  assert.equal(add.getAttribute("value"), "Overlaps WRIT-340");
  assert.equal(add.getAttribute("orig_name"), "Overlaps WRIT-340");
  assert.equal(add.getAttribute("title"), "This class overlaps with WRIT-340!");
  assert.ok(add.classList.contains("warning"));
  assert.ok(add.classList.contains("usc-helper-conflict-button"));
  assert.equal(add.getAttribute("data-usc-helper-conflict-original-text"), "Add");
});

test("a section already on the calendar is not marked as overlapping itself", async (t) => {
  const { run, button } = await setUpDom(t);
  run([{ title: "CSCI 201", sections: [LECTURE_MW_10] }], {
    Data: [meeting("CSCI-201 (29902R)", "M", "10:00", "11:20")],
  });
  assert.ok(!button("29902R")!.classList.contains("warning"));
});

test("Th means Thursday only, and TTh means Tuesday and Thursday", async (t) => {
  const { run, button } = await setUpDom(t);
  run(
    [
      {
        title: "CSCI 201",
        sections: [LECTURE_TTH_1230, { section: "29903R", type: "Lecture", days: "Th", time: "12:30-1:50pm" }],
      },
    ],
    { Data: [meeting("EE-109 (31200R)", "T", "13:00", "13:50")] },
  );
  assert.ok(button("29901R")!.classList.contains("warning"), "TTh overlaps a Tuesday class");
  assert.ok(!button("29903R")!.classList.contains("warning"), "Th does not overlap a Tuesday class");
});

test("the same weekly class repeated across weeks gives the same result as one occurrence", async (t) => {
  const once = await setUpDom(t);
  once.run([{ title: "CSCI 201", sections: [LECTURE_MW_10] }], {
    Data: [meeting("WRIT-340 (66700R)", "W", "10:00", "11:50")],
  });
  const onceText = once.button("29902R")!.textContent;
  once.run([{ title: "CSCI 201", sections: [LECTURE_MW_10] }], {
    Data: [0, 1, 2, 3].flatMap((week) => [
      meeting("WRIT-340 (66700R)", "M", "10:00", "11:50", week),
      meeting("WRIT-340 (66700R)", "W", "10:00", "11:50", week),
    ]),
  });
  assert.equal(once.button("29902R")!.textContent, onceText);
});

test("course title turns orange only when every lecture overlaps; labs don't count", async (t) => {
  const { run, title } = await setUpDom(t);
  const writ = { Data: [meeting("WRIT-340 (66700R)", "M", "10:00", "11:50")] };

  run([{ title: "CSCI 201", sections: [LECTURE_MW_10, LAB_F_12] }], writ);
  assert.ok(title().classList.contains("overlaps"), "the only lecture overlaps; the free lab is ignored");

  run([{ title: "CSCI 201", sections: [LECTURE_MW_10, LECTURE_TTH_1230] }], writ);
  assert.ok(!title().classList.contains("overlaps"), "one lecture is free");

  run([{ title: "CSCI 201", closed: true, sections: [LECTURE_MW_10] }], writ);
  assert.ok(title().classList.contains("closedAndOverlaps"));
  assert.ok(!title().classList.contains("overlaps"));
});

test("a TBA lecture keeps the course title from turning orange", async (t) => {
  const { run, title } = await setUpDom(t);
  t.mock.method(console, "error", () => {});
  run(
    [{ title: "CSCI 201", sections: [LECTURE_MW_10, { section: "29904R", type: "Lecture", days: "", time: "TBA" }] }],
    { Data: [meeting("WRIT-340 (66700R)", "M", "10:00", "11:50")] },
  );
  assert.ok(!title().classList.contains("overlaps"));
});

test("an overlapping section without an Add button still counts toward the orange title", async (t) => {
  const { run, title } = await setUpDom(t);
  run([{ title: "CSCI 201", sections: [{ ...LECTURE_MW_10, button: "none" }] }], {
    Data: [meeting("WRIT-340 (66700R)", "M", "10:00", "11:50")],
  });
  assert.ok(title().classList.contains("overlaps"));
});

test("an empty calendar changes nothing on the page", async (t) => {
  const { dom, run } = await setUpDom(t);
  run([{ title: "CSCI 201", sections: [LECTURE_MW_10] }], { Data: [] });
  assert.equal(dom.document.querySelectorAll(".warning, .overlaps, .usc-helper-conflict-surface").length, 0);
});

test("hovering a marked button offers Add Anyway (or Notify Me) and restores the label after", async (t) => {
  const { run, button, $ } = await setUpDom(t);
  run([{ title: "CSCI 201", sections: [LECTURE_MW_10, { ...LECTURE_TTH_1230, days: "MW", button: "notify" }] }], {
    Data: [meeting("WRIT-340 (66700R)", "M", "10:00", "11:50"), meeting("WRIT-340 (66700R)", "M", "12:00", "14:00")],
  });
  const add = button("29902R")!;
  $(add).trigger("mouseenter");
  assert.equal(add.textContent, "Add Anyway");
  $(add).trigger("mouseleave");
  assert.equal(add.textContent, "Overlaps WRIT-340");

  const notify = button("29901R")!;
  $(notify).trigger("mouseenter");
  assert.equal(notify.textContent, "Notify Me");
  $(notify).trigger("mouseleave");
  assert.equal(notify.textContent, "Overlaps WRIT-340");
});

test("with several overlapping classes repeated over weeks, the first one in calendar order is reported", async (t) => {
  const { run, button } = await setUpDom(t);
  // Week 0 lists WRIT-340 first; week 1 lists MATH-226 first. Collapsing repeats must keep WRIT-340 first.
  run([{ title: "CSCI 201", sections: [LECTURE_MW_10] }], {
    Data: [
      meeting("WRIT-340 (66700R)", "M", "10:00", "11:50"),
      meeting("MATH-226 (39600R)", "M", "11:00", "11:50"),
      meeting("MATH-226 (39600R)", "M", "11:00", "11:50", 1),
      meeting("WRIT-340 (66700R)", "M", "10:00", "11:50", 1),
    ],
  });
  assert.equal(button("29902R")!.textContent, "Overlaps WRIT-340");
});

test("a malformed time is logged once and keeps the course title from turning orange", async (t) => {
  const { run, title, button } = await setUpDom(t);
  const errors = t.mock.method(console, "error", () => {});
  run(
    [
      {
        title: "CSCI 201",
        sections: [LECTURE_MW_10, { section: "29904R", type: "Lecture", days: "M", time: "bad time" }],
      },
    ],
    { Data: [meeting("WRIT-340 (66700R)", "M", "10:00", "11:50")] },
  );
  assert.equal(errors.mock.callCount(), 1);
  assert.ok(button("29902R")!.classList.contains("warning"));
  assert.ok(!title().classList.contains("overlaps"));
});

test("TBA sections are not logged as errors", async (t) => {
  const { run } = await setUpDom(t);
  const errors = t.mock.method(console, "error", () => {});
  run([{ title: "CSCI 201", sections: [{ section: "29904R", type: "Lecture", days: "", time: "TBA" }] }], {
    Data: [meeting("WRIT-340 (66700R)", "M", "10:00", "11:50")],
  });
  assert.equal(errors.mock.callCount(), 0);
});

test("a calendar with no usable entries changes nothing on the page", async (t) => {
  const { dom, run } = await setUpDom(t);
  const unchanged = () =>
    assert.equal(dom.document.querySelectorAll(".warning, .overlaps, .usc-helper-conflict-surface").length, 0);
  run([{ title: "CSCI 201", sections: [LECTURE_MW_10] }], null);
  unchanged();
  run([{ title: "CSCI 201", sections: [LECTURE_MW_10] }], {
    Data: [{ Title: "NOSECTION", Start: "2026-08-24T17:00:00Z", End: "2026-08-24T18:50:00Z" }],
  });
  unchanged();
});

test("a calendar entry whose section number is empty matches every section as 'itself' (existing quirk)", async (t) => {
  const { run, button } = await setUpDom(t);
  // "(R)" leaves an empty section number, and every name starts with "", so it never reports an overlap.
  run([{ title: "CSCI 201", sections: [LECTURE_MW_10] }], {
    Data: [meeting("WRIT-340 (R)", "M", "10:00", "11:50")],
  });
  assert.ok(!button("29902R")!.classList.contains("warning"));
});

test("a section stops being read once its outcome is known", async (t) => {
  const { run, button } = await setUpDom(t);
  const errors = t.mock.method(console, "error", () => {});
  // A row that can't be read sits just before Type. Overlapping and TBA sections never reach Type.
  const poisonBeforeType = (doc: Document) => {
    for (const typeRow of doc.querySelectorAll(".section_row")) {
      if (!typeRow.textContent?.startsWith("Type:")) {
        continue;
      }
      const poison = doc.createElement("span");
      poison.className = "section_row";
      for (const property of ["innerText", "textContent"]) {
        Object.defineProperty(poison, property, {
          get() {
            throw new Error("unreadable row");
          },
        });
      }
      typeRow.parentElement!.appendChild(poison);
      typeRow.parentElement!.appendChild(typeRow);
    }
  };
  run(
    [{ title: "CSCI 201", sections: [LECTURE_MW_10, { section: "29904R", type: "Lecture", days: "", time: "TBA" }] }],
    { Data: [meeting("WRIT-340 (66700R)", "M", "10:00", "11:50")] },
    poisonBeforeType,
  );
  assert.equal(errors.mock.callCount(), 0);
  assert.ok(button("29902R")!.classList.contains("warning"));
});

test("a section with two meeting times (one per line) is checked at both, without logging an error", async (t) => {
  const { run, button, title } = await setUpDom(t);
  const errors = t.mock.method(console, "error", () => {});
  const studio = {
    labelled: true,
    section: "11111R",
    type: "Lecture",
    days: "M<br>W",
    time: "01:00pm-05:50pm<br>02:00pm-03:50pm",
  };
  // Overlaps only the Wednesday pattern.
  run([{ title: "ARCH 202", sections: [studio] }], { Data: [meeting("MATH-407 (39860R)", "W", "15:00", "16:20")] });
  assert.equal(button("11111R")!.textContent, "Overlaps MATH-407");
  assert.ok(title().classList.contains("overlaps"));
  // Overlaps neither pattern.
  run([{ title: "ARCH 202", sections: [studio] }], { Data: [meeting("MATH-407 (39860R)", "W", "16:00", "17:20")] });
  assert.ok(!button("11111R")!.classList.contains("warning"));
  assert.equal(errors.mock.callCount(), 0);
});

test("Time and Days cells that don't pair up line for line mark nothing and log nothing", async (t) => {
  const { run, button, title } = await setUpDom(t);
  const errors = t.mock.method(console, "error", () => {});
  run(
    [
      {
        title: "ARCH 202",
        sections: [
          {
            labelled: true,
            section: "11111R",
            type: "Lecture",
            days: "M<br>W<br>F",
            time: "01:00pm-05:50pm<br>02:00pm-03:50pm",
          },
        ],
      },
    ],
    { Data: [meeting("MATH-407 (39860R)", "W", "15:00", "16:20")] },
  );
  assert.ok(!button("11111R")!.classList.contains("warning"));
  assert.ok(!title().classList.contains("overlaps"));
  assert.equal(errors.mock.callCount(), 0);
});

test("one labelled line reads exactly like before (the label spans are left out)", async (t) => {
  const { run, button } = await setUpDom(t);
  run([{ title: "CSCI 201", sections: [{ ...LECTURE_MW_10, labelled: true }] }], {
    Data: [meeting("WRIT-340 (66700R)", "M", "10:00", "11:50")],
  });
  assert.equal(button("29902R")!.textContent, "Overlaps WRIT-340");
});
