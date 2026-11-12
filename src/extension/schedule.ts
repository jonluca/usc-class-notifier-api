import type { Schedule } from "@/extension/scheduleDocument";
import { parseTimeRange } from "@/extension/courseBinScrape";
import {
  findOverlaps,
  sectionMeetingLines,
  sectionRowValue,
  sectionRows,
  splitDays,
  weeklyMeetings,
} from "@/extension/weekSchedule";
import $ from "jquery";
import { insertAllOverlap } from "./insert-class-info";

export { parseScheduleDocument } from "@/extension/scheduleDocument";
export type { Schedule, ScheduleEntry } from "@/extension/scheduleDocument";

function addConflictOverlay(row: HTMLElement, name: string) {
  const addToCourseBin = $(row).find(".addtomycb, .add-to-course-bin")[0];
  if (!addToCourseBin) {
    return;
  }
  const firstChild = $(row).children()[0];
  const surfaces = firstChild ? $([row, firstChild]) : $(row);
  surfaces.each(function () {
    const surface = $(this);
    if (!surface.hasClass("usc-helper-conflict-surface")) {
      surface
        .attr("data-usc-helper-conflict-original-style", surface.attr("style") ?? "")
        .addClass("usc-helper-conflict-surface");
    }
    surface.css("background-color", "rgba(255, 134, 47, 0.37)");
  });

  const button = $(addToCourseBin);
  if (!button.hasClass("usc-helper-conflict-button")) {
    button
      .attr("data-usc-helper-conflict-original-value", button.attr("value") ?? "")
      .attr("data-usc-helper-conflict-original-text", button.text())
      .attr("data-usc-helper-conflict-original-title", button.attr("title") ?? "")
      .attr("data-usc-helper-conflict-original-orig-name", button.attr("orig_name") ?? "")
      .addClass("usc-helper-conflict-button");
  }
  button.attr("value", `Overlaps ${name}`);
  // set text content of the button to "Overlaps with [class name]"
  button.text(`Overlaps ${name}`);
  button.attr("orig_name", `Overlaps ${name}`);
  button.attr("title", `This class overlaps with ${name}!`);
  button.addClass("warning");
}

export function parseSchedule(data: Schedule) {
  const meetings = weeklyMeetings(data);
  //bail if no classes
  if (meetings.length === 0) {
    return;
  }
  //Iterate over every div. The layout of webreg is alternating divs for class name/code and then its content
  $(".accordion-content-area").each(function () {
    let doAllSectionsOverlap = true;
    const sections = $(this).find(".section");

    sections.each(function () {
      try {
        // Fields are read lazily, in this order, so a section stops being read as soon as its outcome is known.
        const rows = sectionRows(this);
        const timeValue = sectionRowValue(rows, "Time");
        let firstOverlap;
        if (!timeValue?.includes("\n")) {
          // One meeting pattern: exactly the original checks.
          const time = parseTimeRange(timeValue);
          if (!time) {
            doAllSectionsOverlap = false;
            return;
          }
          const days = splitDays(sectionRowValue(rows, "Days"));
          const name = sectionRowValue(rows, "Section") || "";
          [firstOverlap] = findOverlaps({ name, days, time, type: undefined }, meetings);
        } else {
          // Several patterns (one per line): an overlap with any of them counts. Unpairable cells aren't guessed.
          const patterns = (sectionMeetingLines(rows) ?? [])
            .map((line) => ({ days: splitDays(line.days), time: parseTimeRange(line.time) }))
            .filter((pattern) => pattern.time !== null);
          if (patterns.length === 0) {
            doAllSectionsOverlap = false;
            return;
          }
          const name = sectionRowValue(rows, "Section") || "";
          firstOverlap = patterns
            .flatMap(({ days, time }) => findOverlaps({ name, days, time, type: undefined }, meetings))
            .sort((a, b) => meetings.indexOf(a) - meetings.indexOf(b))[0];
        }
        if (firstOverlap) {
          addConflictOverlay(this, firstOverlap.course);
          return;
        }
        if (sectionRowValue(rows, "Type")?.startsWith("Lecture")) {
          doAllSectionsOverlap = false;
        }
      } catch (e) {
        doAllSectionsOverlap = false;
        console.error(e);
      }
    });
    if (doAllSectionsOverlap) {
      insertAllOverlap(this);
    }
  });
  $(".warning")
    .off(".usc-helper-conflict")
    .on("mouseenter.usc-helper-conflict", function () {
      // if it has the notify class, set the value to "Notify Me"
      const text = $(this).hasClass("notify") ? "Notify Me" : "Add Anyway";
      $(this).attr("value", text);
      $(this).text(text);
    })
    .on("mouseleave.usc-helper-conflict", function () {
      const original = $(this).attr("orig_name");
      if (original) {
        $(this).attr("value", original);
        $(this).text(original);
      }
    });
}
