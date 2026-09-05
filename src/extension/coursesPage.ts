import $ from "jquery";
import { getCurrentTerm } from "@/extension/getCurrentTerm";
import { createClassesPageNotifyButton } from "@/extension/notify";
import { syncNotifyButtonDataset } from "@/extension/notifyButtonData";
import { getProfessorRatings, ratingURLTemplate } from "@/extension/utils";

const COURSE_ID_PATTERN = /\b([A-Z]{2,5}\s+\d+[A-Z]?)\b/;
const COURSE_TABLE_SELECTOR = "table, .mat-table, [mat-table], mat-table";
const HELPER_CONTENT_SELECTOR = ".usc-helper-rating-header, .usc-helper-rating-cell, .usc-helper-notify-cell";

let coursePageObserver: MutationObserver | null = null;
let pendingCoursePageParse: number | undefined;
const dirtyTables = new Set<Element>();

function scheduleCoursePageParse() {
  if (pendingCoursePageParse !== undefined || dirtyTables.size === 0) {
    return;
  }

  pendingCoursePageParse = window.setTimeout(() => {
    pendingCoursePageParse = undefined;
    const tables = [...dirtyTables];
    dirtyTables.clear();
    for (const table of tables) {
      if (table.isConnected) {
        parseCoursePage(table);
      }
    }
  }, 0);
}

function getTextContent(element: Element | undefined) {
  return element?.textContent?.replace(/\s+/g, " ").trim() || "";
}

function getColumnIndex(cells: Element[], label: string) {
  return cells.findIndex((cell) => getTextContent(cell) === label);
}

function getClassesPageSemester() {
  return getCurrentTerm();
}

function findCourseIdForTable(element: HTMLElement) {
  let current: HTMLElement | null = element;

  while (current) {
    const candidates = [
      current.getAttribute("aria-label") || "",
      ...$(current)
        .children("button, [role='button'], h1, h2, h3, h4")
        .toArray()
        .map((node) => node.textContent || ""),
      ...$(current)
        .prevAll()
        .toArray()
        .slice(0, 3)
        .flatMap((node) => [
          node.textContent || "",
          ...$(node)
            .find("button, [role='button'], h1, h2, h3, h4")
            .toArray()
            .map((child) => child.textContent || ""),
        ]),
    ];

    for (const candidate of candidates) {
      const match = candidate.replace(/\s+/g, " ").match(COURSE_ID_PATTERN);
      if (match?.[1]) {
        return match[1];
      }
    }
    current = current.parentElement;
  }

  return undefined;
}

function addNotifyButtons(parent: JQuery<HTMLElement>) {
  const headerRow = parent.find("mat-header-row, thead tr, tr").first();
  if (!headerRow.length) {
    return;
  }

  const headerCells = headerRow.find("mat-header-cell, th, td").not(".usc-helper-rating-header").toArray();
  const sectionIndex = getColumnIndex(headerCells, "SECTION");
  const registeredIndex = getColumnIndex(headerCells, "REGISTERED");
  const detailsIndex = getColumnIndex(headerCells, "DETAILS");

  if (sectionIndex === -1 || registeredIndex === -1) {
    return;
  }

  const tableElement = parent[0];
  if (!tableElement) {
    return;
  }
  const fullCourseId = findCourseIdForTable(tableElement);
  const department = fullCourseId?.split(/\s+/)[0] || "";
  const semester = getClassesPageSemester();
  if (!department) {
    return;
  }
  const rows = parent.find("mat-row, tr").toArray();

  for (const row of rows) {
    const cells = $(row).find("mat-cell, td").not(".usc-helper-rating-cell").toArray();
    if (cells.length <= Math.max(sectionIndex, registeredIndex)) {
      continue;
    }

    const sectionId = getTextContent(cells[sectionIndex]).replace(/\D/g, "");
    const registeredText = getTextContent(cells[registeredIndex]);
    if (!sectionId || !/^\d+\s*\/\s*\d+$/.test(registeredText)) {
      continue;
    }

    const targetCell = detailsIndex >= 0 && cells.length > detailsIndex ? cells[detailsIndex] : cells[cells.length - 1];
    if (!targetCell) {
      continue;
    }

    const buttonData = {
      sectionId,
      department,
      fullCourseId,
      semester,
    };
    const existingButton = $(targetCell).find(".usc-helper-notify-button").first();
    if (existingButton[0]) {
      syncNotifyButtonDataset(existingButton[0].dataset, buttonData);
      continue;
    }

    $(targetCell).append(
      $("<div>", { class: "usc-helper-notify-cell" }).append(createClassesPageNotifyButton(buttonData)),
    );
  }
}

function parseCoursePage(root: Document | Element = document) {
  // Find all mat-header-cell where the text is "Instructor"
  const headerCells = $(root)
    .find("mat-header-cell, th")
    .filter(function () {
      const textValue = $(this).text().trim();
      return textValue === "INSTRUCTOR" || textValue === "INSTRUCTORS";
    })
    .toArray();
  // now for each one, we want to add a new header cell after it
  for (const headerCell of headerCells) {
    if ($(headerCell).next(".rating-header").length === 0) {
      // clone it and change text
      const newHeaderCell = $(headerCell).clone();
      newHeaderCell.text("PROF RATING");
      newHeaderCell.addClass("rating-header usc-helper-rating-header");
      // insert after
      $(headerCell).after(newHeaderCell);
    }
    // find its index in the header, then insert the rating for each row at that index + 1
    const headerIndex = $(headerCell).index();
    // now find all rows
    const parent = $(headerCell).closest("mat-table, table");
    if (parent.length === 0) {
      continue;
    }
    addNotifyButtons(parent);
    const rows = parent.find("mat-row, tr").toArray();
    for (const row of rows) {
      const cells = $(row).find("mat-cell, td").toArray();
      if (cells.length <= headerIndex) {
        continue;
      }
      const instructorCell = cells[headerIndex];
      if (!instructorCell) {
        continue;
      }
      const instructorNames = (instructorCell.textContent || "").split(",").map((l) => l.trim());
      const toAdd: string[] = [];
      for (const name of instructorNames) {
        const professors = getProfessorRatings(name);
        if (professors) {
          for (const prof of professors) {
            const url = ratingURLTemplate + prof.legacyId;
            toAdd.push(`<a href="${url}" style="padding-left: 2px;" target="_blank">${prof.avgRating || "Link"}</a>`);
          }
        }
      }
      const ratingsHTML = toAdd.join(", ") || " ";
      const existingCell = $(row).find(".rating").first();
      if (!existingCell.length) {
        const newCell = $(instructorCell).clone();
        newCell.addClass("rating usc-helper-rating-cell");
        newCell.html(ratingsHTML);
        $(instructorCell).after(newCell);
      } else if (existingCell.html() !== ratingsHTML) {
        existingCell.html(ratingsHTML);
      }
    }
  }
}
function isHelperContent(node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest(HELPER_CONTENT_SELECTOR));
}

function collectTables(element: Element) {
  const table = element.closest(COURSE_TABLE_SELECTOR);
  if (table) {
    dirtyTables.add(table);
    return;
  }
  for (const table of element.querySelectorAll(COURSE_TABLE_SELECTOR)) {
    dirtyTables.add(table);
  }
}

function observeCourseTables() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (isHelperContent(mutation.target)) {
        continue;
      }
      // Inserting our own controls must not schedule another parse of the table.
      if (mutation.type === "childList") {
        const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
        if (changedNodes.length > 0 && changedNodes.every(isHelperContent)) {
          continue;
        }
      }

      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (!target) {
        continue;
      }
      const table = target.closest(COURSE_TABLE_SELECTOR);
      if (table) {
        dirtyTables.add(table);
      }
      if (mutation.type === "attributes") {
        // Accordion visibility changes can happen on a table's ancestor.
        collectTables(target);
      } else if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          const element = node instanceof Element ? node : node.parentElement;
          if (element && !isHelperContent(node)) {
            collectTables(element);
          }
        }
      }
    }
    scheduleCoursePageParse();
  });

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["aria-expanded", "class", "hidden", "style"],
    characterData: true,
    childList: true,
    subtree: true,
  });
  return observer;
}

export function initCoursePage() {
  cleanupCoursePage();
  parseCoursePage();
  coursePageObserver = observeCourseTables();
}

export function cleanupCoursePage() {
  if (pendingCoursePageParse !== undefined) {
    window.clearTimeout(pendingCoursePageParse);
    pendingCoursePageParse = undefined;
  }
  dirtyTables.clear();
  coursePageObserver?.disconnect();
  coursePageObserver = null;
}
