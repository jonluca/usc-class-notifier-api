import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ratings from "@/data/ratings.json" with { type: "json" };

async function createCourseDocument() {
  const resolveFromTest = createRequire(import.meta.url);
  const resolveFromWxt = createRequire(resolveFromTest.resolve("wxt"));
  // SAFETY: LinkeDOM supplies the browser DOM interfaces used by this detached-document test.
  const linkedom = (await import(pathToFileURL(resolveFromWxt.resolve("linkedom")).href)) as {
    parseHTML: (html: string) => { document: Document; window: Window & typeof globalThis };
  };
  return linkedom.parseHTML("<html><body></body></html>");
}

function courseMarkup(id: string, instructor: string, sectionId = "12345") {
  return `<section aria-label="CSCI ${id}"><mat-table id="course-${id}">
    <mat-header-row><mat-header-cell>SECTION</mat-header-cell><mat-header-cell>INSTRUCTOR</mat-header-cell><mat-header-cell>REGISTERED</mat-header-cell><mat-header-cell>DETAILS</mat-header-cell></mat-header-row>
    <mat-row><mat-cell>${sectionId}</mat-cell><mat-cell class="instructor">${instructor}</mat-cell><mat-cell>1/2</mat-cell><mat-cell></mat-cell></mat-row>
  </mat-table></section>`;
}

const settleMutations = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

test("course table updates stay scoped, coalesce bursts, and settle without reparsing helper writes", async (t) => {
  const dom = await createCourseDocument();
  const globals = ["document", "window", "Element", "MutationObserver"] as const;
  const originalGlobals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, {
    document: dom.document,
    window: dom.window,
    Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
  });
  Object.defineProperty(dom.window, "location", { configurable: true, value: { pathname: "/term/20263/" } });
  const { initCoursePage, cleanupCoursePage } = await import("@/extension/coursesPage");
  t.after(() => {
    cleanupCoursePage();
    for (const [index, key] of globals.entries()) {
      const descriptor = originalGlobals[index];
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  });

  const professor = ratings[0];
  assert.ok(professor);
  const name = `${professor.firstName} ${professor.lastName}`;
  dom.document.body.innerHTML = courseMarkup("104", name) + courseMarkup("170", name, "67890");
  initCoursePage();
  const firstTable = dom.document.getElementById("course-104");
  const secondTable = dom.document.getElementById("course-170");
  assert.ok(firstTable);
  assert.ok(secondTable);
  assert.equal(dom.document.querySelectorAll(".usc-helper-notify-button").length, 2);
  assert.equal(firstTable.querySelector(".usc-helper-notify-button")?.getAttribute("data-section-id"), "12345");
  const initialLink = firstTable.querySelector(".rating a");
  assert.ok(initialLink);
  assert.equal(initialLink.getAttribute("href"), `https://www.ratemyprofessors.com/professor/${professor.legacyId}`);

  const firstQueries = t.mock.method(firstTable, "querySelectorAll");
  const secondQueries = t.mock.method(secondTable, "querySelectorAll");
  const tableParseCount = () =>
    firstQueries.mock.calls.filter((call) => call.arguments[0].includes("mat-header-cell")).length;
  firstTable.setAttribute("class", "expanded");
  firstTable.setAttribute("style", "display: block");
  firstTable.setAttribute("aria-expanded", "true");
  await settleMutations();
  assert.equal(tableParseCount(), 1, "one table is parsed once for a burst of visibility changes");
  assert.equal(secondQueries.mock.callCount(), 0, "an untouched course table is not scanned");
  assert.equal(firstTable.querySelector(".rating a"), initialLink, "unchanged rating links keep their DOM identity");

  const instructor = firstTable.querySelector(".instructor");
  assert.ok(instructor);
  instructor.textContent = "An Unknown Instructor";
  await settleMutations();
  assert.equal(firstTable.querySelector(".rating")?.textContent, " ");
  assert.equal(tableParseCount(), 2, "a live instructor update is parsed once");
  await settleMutations();
  assert.equal(tableParseCount(), 2, "rendered helper cells do not trigger another parse");

  const row = dom.document.createElement("mat-row");
  row.innerHTML = "<mat-cell>11223</mat-cell><mat-cell>Unknown</mat-cell><mat-cell>2/2</mat-cell><mat-cell></mat-cell>";
  firstTable.append(row);
  await settleMutations();
  assert.equal(row.querySelector(".usc-helper-notify-button")?.getAttribute("data-section-id"), "11223");
  assert.equal(row.querySelectorAll(".usc-helper-rating-cell").length, 1);
  assert.equal(tableParseCount(), 3, "a newly inserted row is handled without scanning other tables");
  assert.equal(secondQueries.mock.callCount(), 0);

  dom.document.body.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await settleMutations();
  assert.equal(tableParseCount(), 3, "unrelated clicks do not rescan course tables");
  assert.equal(secondQueries.mock.callCount(), 0);

  const wrapper = dom.document.createElement("div");
  wrapper.innerHTML = courseMarkup("201", name, "33333");
  dom.document.body.append(wrapper);
  await settleMutations();
  assert.equal(wrapper.querySelectorAll(".usc-helper-notify-button").length, 1);
  assert.equal(wrapper.querySelectorAll(".usc-helper-rating-cell").length, 1);
  assert.equal(tableParseCount(), 3);

  const closedWrapper = dom.document.createElement("div");
  closedWrapper.innerHTML = courseMarkup("270", name, "44444").replace("1/2", "Closed");
  dom.document.body.append(closedWrapper);
  await settleMutations();
  assert.equal(closedWrapper.querySelectorAll(".usc-helper-notify-button").length, 0);
  const seatCell = [...closedWrapper.querySelectorAll("mat-cell")].find((cell) => cell.textContent === "Closed");
  assert.ok(seatCell);
  seatCell.textContent = "0/20";
  await settleMutations();
  assert.equal(closedWrapper.querySelector(".usc-helper-notify-button")?.getAttribute("data-section-id"), "44444");
  assert.equal(tableParseCount(), 3, "seat-count changes update only the relevant table");

  instructor.textContent = name;
  await Promise.resolve();
  cleanupCoursePage();
  await settleMutations();
  assert.equal(tableParseCount(), 3, "cleanup cancels queued table updates");
  assert.equal(firstTable.querySelector(".rating")?.textContent, " ");
});
