import $ from "jquery";
import { cleanupCoursePage, initCoursePage } from "@/extension/coursesPage";
import { parseWebRegPage } from "@/extension/webRegPage";
import type { Options } from "@/extension/utils";
import { getCurrentSchedule, parseSchedule } from "@/extension/schedule";
import { getCurrentTerm } from "@/extension/getCurrentTerm";

function insertExportButton() {
  const navbar = $("ul.nav");
  $(navbar).find(".exportCal").remove();

  $(navbar).append(
    `<li><a class="exportCal" href="https://my.usc.edu/ical/?term=${getCurrentTerm()}">Export To Calendar</a></li>`,
  );
  const cals = $(".exportCal");
  const duplicateCalendarLink = cals[1];
  if (duplicateCalendarLink) {
    $(duplicateCalendarLink).remove();
  }
}

let initializationId = 0;

function restoreAttribute(element: JQuery<HTMLElement>, dataAttribute: string, attribute: string) {
  const original = element.attr(dataAttribute);
  if (original === undefined) {
    return;
  }
  if (original === "") {
    element.removeAttr(attribute);
  } else {
    element.attr(attribute, original);
  }
  element.removeAttr(dataAttribute);
}

function cleanupExtension() {
  cleanupCoursePage();
  $(".usc-helper-conflict-button").each(function () {
    const button = $(this);
    button.off(".usc-helper-conflict");
    restoreAttribute(button, "data-usc-helper-conflict-original-value", "value");
    restoreAttribute(button, "data-usc-helper-conflict-original-title", "title");
    restoreAttribute(button, "data-usc-helper-conflict-original-orig-name", "orig_name");
    const originalText = button.attr("data-usc-helper-conflict-original-text");
    if (originalText !== undefined) {
      button.text(originalText).removeAttr("data-usc-helper-conflict-original-text");
    }
    button.removeClass("usc-helper-conflict-button warning");
  });
  $(".usc-helper-modified-button").each(function () {
    const button = $(this);
    restoreAttribute(button, "data-usc-helper-original-value", "value");
    const originalText = button.attr("data-usc-helper-original-text");
    if (originalText !== undefined) {
      button.text(originalText).removeAttr("data-usc-helper-original-text");
    }
    button.removeClass("usc-helper-modified-button");
  });
  $(".usc-helper-conflict-surface, .usc-helper-modified-style").each(function () {
    const element = $(this);
    if (element.hasClass("usc-helper-conflict-surface")) {
      restoreAttribute(element, "data-usc-helper-conflict-original-style", "style");
    }
    if (element.hasClass("usc-helper-modified-style")) {
      restoreAttribute(element, "data-usc-helper-original-style", "style");
    }
    element.removeClass("usc-helper-conflict-surface usc-helper-modified-style");
  });

  $(".usc-helper-rating-header, .usc-helper-rating-cell, .usc-helper-units").remove();
  $(".usc-helper-notify-button, .usc-helper-webreg-notify-container, .exportCal").remove();
  $("#usc-schedule-helper-styles").remove();
  $(".blank_rating").removeClass("blank_rating");
  $(".closed, .overlaps, .closedAndOverlaps").removeClass("closed overlaps closedAndOverlaps");
  $(".spots_remaining").remove();
}

export const initExtension = (options: Options) => {
  const currentInitialization = ++initializationId;
  cleanupExtension();

  if (!options.enabled) {
    return cleanupExtension;
  }
  const currentURL = window.location.href;

  if (currentURL.includes("webreg")) {
    insertExportButton();
    if (!currentURL.includes("/myCourseBin")) {
      if (options.showConflicts) {
        getCurrentSchedule().then((data) => {
          if (currentInitialization === initializationId && data) {
            parseSchedule(data);
          }
        });
      }
      // parse web reg
      parseWebRegPage(options);
    }
  } else {
    initCoursePage();
  }

  return () => {
    if (currentInitialization === initializationId) {
      initializationId += 1;
      cleanupExtension();
    }
  };
};
