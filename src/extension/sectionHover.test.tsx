import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { describeSection, HOVER_DELAY_MS, sectionAt } from "@/extension/sectionHover";
import { parseDetachedDocument } from "@/extension/testing/detachedDocument";

const COURSE_BIN = readFileSync(new URL("./fixtures/courseBin-20271-2026-11-01.html", import.meta.url), "utf8");

test("reads a real WebReg section row: course from the header, section, type, days and time", async () => {
  const doc = await parseDetachedDocument(COURSE_BIN);
  assert.deepEqual(describeSection(doc.getElementById("section_10001")!), {
    course: "CSCI-201",
    name: "10001R",
    type: "Lab",
    meetings: [{ days: ["Wednesday"], time: { start: "08:00", end: "09:50" } }],
    unreadable: false,
  });
});

test("never relies on visible text: WebReg hides the 'Time:' labels at desktop widths", async () => {
  const doc = await parseDetachedDocument(COURSE_BIN);
  // In Chrome at desktop width, innerText leaves the hidden labels out. Make that true here, and worse.
  for (const row of doc.querySelectorAll("#section_10001 .section_row")) {
    Object.defineProperty(row, "innerText", {
      get() {
        throw new Error("innerText must not be used");
      },
    });
  }
  const described = describeSection(doc.getElementById("section_10001")!);
  assert.deepEqual(described.meetings[0]?.time, { start: "08:00", end: "09:50" });
  assert.equal(described.name, "10001R");
});

// Course-search pages title a course like "CSCI-104 L: Data Structures" inside .course-title-indent.
function coursePage(header: string, rows: Record<string, string>) {
  return `<div class="course-header"><a class="course-title-indent">${header}</a></div>
    <div class="accordion-content-area"><div class="section" id="s">${Object.entries(rows)
      .map(
        ([label, value]) =>
          `<span class="section_row"><span class="hidden-lg hidden-md table-headers-xsmall">${label}: </span>${value}</span>`,
      )
      .join("")}<button class="addtomycb">Add</button></div></div>
    <div class="section" id="loose"><span class="section_row">Section: 1 R</span></div>`;
}

test("reads the course code from a course-search page header", async () => {
  const doc = await parseDetachedDocument(
    coursePage("CSCI-104 L: Data Structures - 4.0 units", {
      Section: "30379 R",
      Type: "Lab",
      Days: "Th",
      Time: "02:00pm-03:50pm",
    }),
  );
  assert.deepEqual(describeSection(doc.getElementById("s")!), {
    course: "CSCI-104",
    name: "30379R",
    type: "Lab",
    meetings: [{ days: ["Thursday"], time: { start: "14:00", end: "15:50" } }],
    unreadable: false,
  });
});

test("Saturday and Sunday sections, and unreadable day codes", async () => {
  const days = async (value: string) =>
    describeSection(
      (
        await parseDetachedDocument(coursePage("CSCI-104", { Section: "1 R", Days: value, Time: "09:00am-10:00am" }))
      ).getElementById("s")!,
    ).meetings[0]?.days ?? [];
  assert.deepEqual(await days("Sa"), ["Saturday"]);
  assert.deepEqual(await days("MWF"), ["Monday", "Wednesday", "Friday"]);
  assert.deepEqual(await days("TTh"), ["Tuesday", "Thursday"]);
  assert.deepEqual(await days("Su"), ["Sunday"]);
  assert.deepEqual(await days("TBA"), []);
  assert.deepEqual(await days("Xy"), [], "unknown codes aren't guessed");
});

test("a section with two meeting times becomes two meetings, each with its own days", async () => {
  const doc = await parseDetachedDocument(
    coursePage("ARCH-202", { Section: "1 R", Days: "M<br>W", Time: "01:00pm-05:50pm<br>02:00pm-03:50pm" }),
  );
  assert.deepEqual(describeSection(doc.getElementById("s")!).meetings, [
    { days: ["Monday"], time: { start: "13:00", end: "17:50" } },
    { days: ["Wednesday"], time: { start: "14:00", end: "15:50" } },
  ]);
});

test("Time and Days cells that don't pair up line for line aren't guessed", async () => {
  const doc = await parseDetachedDocument(
    coursePage("ARCH-202", { Section: "1 R", Days: "M<br>W<br>F", Time: "01:00pm-05:50pm<br>02:00pm-03:50pm" }),
  );
  const described = describeSection(doc.getElementById("s")!);
  assert.deepEqual(described.meetings, []);
  assert.equal(described.unreadable, true);
});

test("only sections inside WebReg's course lists count as hover targets", async () => {
  const doc = await parseDetachedDocument(coursePage("CSCI-104", { Section: "1 R" }));
  const button = doc.querySelector("#s button")!;
  assert.equal(sectionAt(button), doc.getElementById("s"));
  assert.equal(sectionAt(doc.getElementById("loose")), null);
  assert.equal(sectionAt(doc.body), null);
  assert.equal(sectionAt(null), null);
});

// The hook, driven by real DOM events in a LinkeDOM page.
async function setUpHook() {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  // SAFETY: LinkeDOM's parseHTML returns a document and window with the DOM interfaces React needs.
  const { parseHTML } = (await import(pathToFileURL(resolveFromWxt.resolve("linkedom")).href)) as {
    parseHTML: (html: string) => { document: Document; window: Window & typeof globalThis };
  };
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useHoveredSection } = await import("@/extension/sectionHover");
  return { dom, React, createRoot, useHoveredSection };
}
const hookReady = setUpHook();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mountHook(t: test.TestContext) {
  const { dom, React, createRoot, useHoveredSection } = await hookReady;
  dom.document.body.innerHTML = `<div class="accordion-content-area">
      <div class="section" id="a"><span class="section_row">Section: 1 R</span><span class="section_row">Time: 10:00-10:50am</span><button>Add</button></div>
      <div class="section" id="b"><span class="section_row">Section: 2 R</span><span class="section_row">Time: 11:00-11:50am</span><button>Add</button></div>
    </div><p id="outside">elsewhere</p><div id="root"></div>`;
  const seen: (string | null)[] = [];
  function Probe() {
    const hovered = useHoveredSection(dom.document);
    React.useEffect(() => {
      seen.push(hovered?.name ?? null);
    }, [hovered]);
    return null;
  }
  const root = createRoot(dom.document.getElementById("root")!);
  await React.act(async () => root.render(React.createElement(Probe)));
  t.after(() => React.act(async () => root.unmount()));
  const fire = (id: string, type: string, relatedTarget: Element | null = null) =>
    React.act(async () => {
      const event = new dom.window.Event(type, { bubbles: true });
      Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
      dom.document.querySelector(`#${id} span, #${id}`)!.dispatchEvent(event);
    });
  const settle = () => React.act(() => wait(HOVER_DELAY_MS + 60));
  return { seen, fire, settle, dom, root, React };
}

test("hovering a section shows it after a short delay, not instantly", async (t) => {
  const { seen, fire, React } = await mountHook(t);
  await fire("a", "mouseover");
  await React.act(() => wait(HOVER_DELAY_MS / 3));
  assert.deepEqual(seen, [null], "not yet");
  await React.act(() => wait(HOVER_DELAY_MS));
  assert.deepEqual(seen, [null, "1R"]);
});

test("sweeping quickly across rows only shows where the pointer stops", async (t) => {
  const { seen, fire, settle } = await mountHook(t);
  await fire("a", "mouseover");
  await fire("b", "mouseover");
  await fire("a", "mouseover");
  await fire("b", "mouseover");
  await settle();
  assert.deepEqual(seen, [null, "2R"]);
});

test("moving around inside the same section doesn't re-trigger it", async (t) => {
  const { seen, fire, settle, dom, React } = await mountHook(t);
  await fire("a", "mouseover");
  await settle();
  await React.act(async () => {
    dom.document.querySelector("#a button")!.dispatchEvent(new dom.window.Event("mouseover", { bubbles: true }));
  });
  await settle();
  assert.deepEqual(seen, [null, "1R"]);
});

test("pointing away from the sections, or leaving the window, clears it", async (t) => {
  const { seen, fire, settle } = await mountHook(t);
  await fire("a", "mouseover");
  await settle();
  await fire("outside", "mouseover");
  await settle();
  await fire("b", "mouseover");
  await settle();
  await fire("b", "mouseout", null);
  await settle();
  assert.deepEqual(seen, [null, "1R", null, "2R", null]);
});

test("keyboard focus works the same way, and tabbing out of the sections clears it", async (t) => {
  const { seen, fire, settle, dom } = await mountHook(t);
  await fire("a", "focusin");
  await settle();
  await fire("a", "focusout", dom.document.querySelector("#b button"));
  await fire("b", "focusin");
  await settle();
  await fire("b", "focusout", dom.document.getElementById("outside"));
  await settle();
  assert.deepEqual(seen, [null, "1R", "2R", null]);
});

test("unmounting removes every listener it added and cancels a pending update", async (t) => {
  const { dom, React, createRoot, useHoveredSection } = await hookReady;
  dom.document.body.innerHTML = `<div class="accordion-content-area"><div class="section" id="a"><span class="section_row">Section: 1 R</span></div></div><div id="root"></div>`;
  const active = new Map<string, number>();
  const add = dom.document.addEventListener.bind(dom.document);
  const remove = dom.document.removeEventListener.bind(dom.document);
  t.mock.method(dom.document, "addEventListener", (type: string, listener: EventListener) => {
    active.set(type, (active.get(type) ?? 0) + 1);
    add(type, listener);
  });
  t.mock.method(dom.document, "removeEventListener", (type: string, listener: EventListener) => {
    active.set(type, (active.get(type) ?? 0) - 1);
    remove(type, listener);
  });
  let updates = 0;
  function Probe() {
    const hovered = useHoveredSection(dom.document);
    React.useEffect(() => {
      updates += hovered ? 1 : 0;
    }, [hovered]);
    return null;
  }
  const root = createRoot(dom.document.getElementById("root")!);
  await React.act(async () => root.render(React.createElement(Probe)));
  assert.ok([...active.values()].some((count) => count > 0));
  const cleared: unknown[] = [];
  const realClear = globalThis.clearTimeout;
  t.mock.method(globalThis, "clearTimeout", (id: Parameters<typeof clearTimeout>[0]) => {
    cleared.push(id);
    realClear(id);
  });
  // A hover is pending (inside the delay) when the panel goes away.
  await React.act(async () => {
    dom.document.querySelector("#a span")!.dispatchEvent(new dom.window.Event("mouseover", { bubbles: true }));
  });
  const clearedBefore = cleared.length;
  await React.act(async () => root.unmount());
  assert.ok(cleared.length > clearedBefore, "the pending timer was cancelled");
  assert.deepEqual(
    [...active.values()].filter((count) => count !== 0),
    [],
    "every listener removed",
  );
  await wait(HOVER_DELAY_MS + 60);
  assert.equal(updates, 0);
});

test("clicking text in the row you're pointing at keeps that row, even as focus leaves another", async (t) => {
  const { seen, fire, settle, dom } = await mountHook(t);
  await fire("a", "focusin");
  await settle();
  await fire("b", "mouseover");
  await settle();
  assert.deepEqual(seen, [null, "1R", "2R"], "the pointer wins over keyboard focus");
  // Clicking plain text in b moves focus off a's button to nowhere.
  await fire("a", "focusout", null);
  await settle();
  assert.deepEqual(seen, [null, "1R", "2R"]);
  // When the pointer leaves the sections, nothing is focused there either, so it clears.
  await fire("outside", "mouseover");
  await settle();
  assert.deepEqual(seen, [null, "1R", "2R", null]);
  void dom;
});

test("moving the pointer onto the preview panel keeps what it shows", async (t) => {
  const { seen, fire, settle, dom } = await mountHook(t);
  const panel = dom.document.createElement("section");
  panel.className = "usc-helper-week-preview";
  panel.id = "panel";
  dom.document.body.append(panel);
  await fire("a", "mouseover");
  await settle();
  await fire("panel", "mouseover");
  await settle();
  assert.deepEqual(seen, [null, "1R"]);
});
