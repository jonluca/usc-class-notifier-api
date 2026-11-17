import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";

async function createNotificationDocument() {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  // SAFETY: LinkeDOM supplies the browser DOM interfaces used by this detached-document test.
  const linkedom = (await import(pathToFileURL(resolveFromWxt.resolve("linkedom")).href)) as {
    parseHTML: (html: string) => { document: Document; window: Window & typeof globalThis };
  };
  return linkedom.parseHTML("<html><body></body></html>");
}

function courseMarkup(sections: string, course = "CHEM-105a") {
  return `<a id="activeTermTab">Spring 2027 Classes</a>
    <div class="course-header"><span class="crsID">${course}:</span><span class="crsTitl">Chemistry</span></div>
    <div class="accordion-content-area"><div class="section-table">${sections}</div></div>`;
}

function sectionRows(section: string) {
  return `<span class="section_row"><span class="table-headers-xsmall">Section: </span><b>${section} R</b></span>
    <span class="section_row"><span class="table-headers-xsmall">Session: </span>001</span>
    <span class="section_row"><span class="table-headers-xsmall">Type: </span>Lab</span>
    <span class="section_row"><span class="table-headers-xsmall">Registered: </span>0 of 24</span>`;
}

test("WebReg notification buttons identify their own section even without a registration form", async (t) => {
  const dom = await createNotificationDocument();
  const globals = ["document", "window", "Element"] as const;
  const originalGlobals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, {
    document: dom.document,
    window: dom.window,
    Element: dom.window.Element,
  });
  Object.defineProperty(dom.window, "location", { configurable: true, value: { pathname: "/Courses" } });
  // LinkeDOM has no layout engine; inserting the fallback button only needs its inline styles.
  Object.defineProperty(dom.window, "getComputedStyle", {
    configurable: true,
    value: (element: HTMLElement) => element.style,
  });
  const { addNotifyMe } = await import("@/extension/notify");
  const { context } = await import("@/extension/context");
  t.after(() => {
    context.getState().setSelectedClass(null);
    for (const [index, key] of globals.entries()) {
      const descriptor = originalGlobals[index];
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  });

  function clickNotify(section: HTMLElement) {
    context.getState().setSelectedClass(null);
    // LinkeDOM's Attr omits browser textContent; preserve the legacy handler's URL read in this fixture.
    for (const form of section.querySelectorAll("form[data-ajax-url]")) {
      const attribute = form.attributes.getNamedItem("data-ajax-url")!;
      Object.defineProperty(attribute, "textContent", { configurable: true, value: attribute.value });
    }
    addNotifyMe(section);
    const button = section.querySelector<HTMLElement>(".notify");
    assert.ok(button, "the normal extension insertion creates the notification control");
    button.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    return context.getState().selectedClass;
  }

  function assertSelected(section: HTMLElement, sectionId: string, course = "CHEM-105a") {
    const selected = clickNotify(section);
    assert.ok(selected && !("isInvalid" in selected), `section ${sectionId} must open the notification form`);
    assert.equal(selected.sectionId, sectionId);
    assert.equal(selected.department, course.split("-")[0]);
    assert.equal(selected.fullCourseId?.replace(/:$/, ""), course);
    assert.equal(selected.semester, "20271");
  }

  await t.test("lab rows without forms resolve their own container ID and course header", () => {
    dom.document.body.innerHTML = courseMarkup(`<div class="section" id="section_17302">${sectionRows("17302")}</div>`);
    assertSelected(dom.document.querySelector<HTMLElement>(".section")!, "17302");
  });

  await t.test("a labeled section number works without a form or container ID and preserves leading zeros", () => {
    dom.document.body.innerHTML = courseMarkup(`<div class="section">${sectionRows("03172")}</div>`, "LAW-532");
    assertSelected(dom.document.querySelector<HTMLElement>(".section")!, "03172", "LAW-532");
  });

  await t.test("the real CourseBin fixture resolves a fallback button outside section_crsbin", async () => {
    const fixture = await readFile(new URL("./fixtures/courseBin-20271-2026-11-01.html", import.meta.url), "utf8");
    dom.document.body.innerHTML = fixture.replace(/^.*?<body>/s, "").replace(/<\/body>.*$/s, "");
    const section = dom.document.getElementById("section_10001");
    assert.ok(section);
    assertSelected(section, "10001", "CSCI-201");
    assert.equal(section.querySelector(".notify")?.closest(".section_crsbin"), null);
  });

  await t.test("CourseBin buttons inserted into section_crsbin retain the course department without a form", () => {
    dom.document.body.innerHTML = courseMarkup(`<div class="section" id="section_17302">
      <div class="section_crsbin">${sectionRows("17302")}</div></div>`);
    assertSelected(dom.document.querySelector<HTMLElement>(".section_crsbin")!, "17302");
  });

  await t.test("lecture forms still resolve the existing section action URL", () => {
    dom.document.body.innerHTML = courseMarkup(`<div class="section">
      <form data-ajax-url="/api/Section/20271/17300/add"><div class="btnAddToMyCourseBin"></div></form>
      </div>`);
    assertSelected(dom.document.querySelector<HTMLElement>(".section")!, "17300");
  });

  await t.test("legacy forms still resolve their sectionid input", () => {
    dom.document.body.innerHTML = courseMarkup(
      `<div class="section">
      <form><input id="sectionid" name="sectionid" value="03172"><div class="btnAddToMyCourseBin"></div></form>
      </div>`,
      "LAW-532",
    );
    assertSelected(dom.document.querySelector<HTMLElement>(".section")!, "03172", "LAW-532");
  });

  await t.test("a form-free lab does not borrow its neighboring lecture's form", () => {
    dom.document.body.innerHTML = courseMarkup(`<div class="section" id="lecture">
      <form data-ajax-url="/api/Section/20271/17300/add"><div class="btnAddToMyCourseBin"></div></form>
      </div><div class="section" id="section_17302">${sectionRows("17302")}</div>`);
    assertSelected(dom.document.getElementById("section_17302")!, "17302");
  });

  await t.test("a missing section number stays invalid instead of using adjacent lecture data or other numbers", () => {
    dom.document.body.innerHTML = courseMarkup(`<div class="section" id="section_17300">
      <form data-ajax-url="/api/Section/20271/17300/add"><div class="btnAddToMyCourseBin"></div></form>
      </div><div class="section" id="missing">
      <span class="section_row"><span class="table-headers-xsmall">Session: </span>001</span>
      <span class="section_row"><span class="table-headers-xsmall">Registered: </span>0 of 24</span></div>`);
    assert.deepEqual(clickNotify(dom.document.getElementById("missing")!), { isInvalid: true });
  });
});
