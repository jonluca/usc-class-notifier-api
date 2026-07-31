import { splitDays } from "@/extension/utils";
import $ from "jquery";
import { insertAllOverlap } from "./insert-class-info";

import moment from "moment";
const USC_TIMEZONE = "America/Los_Angeles";
const uscDayFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  timeZone: USC_TIMEZONE,
});
const uscTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
  timeZone: USC_TIMEZONE,
});
export interface Schedule {
  Data: Datum[];
}

export interface Datum {
  Id: string;
  Term: string;
  Title: string;
  SectionId: string;
  Status: Status;
  Start: string | Date;
  End: string | Date;
  StartTimezone: null;
  EndTimezone: null;
  RecurrenceRule: null;
  RecurrenceException: null;
  Description: null;
  IsAllDay: boolean;
}

export enum Status {
  Conflicted = "Conflicted",
  Scheduled = "Scheduled",
}

function parseScheduleDate(dateLike: string | Date) {
  if (dateLike instanceof Date) {
    return Number.isNaN(dateLike.getTime()) ? null : dateLike;
  }
  const microsoftJsonDateMatch = dateLike.match(/\/Date\((\d+)(?:[-+]\d+)?\)\//);
  if (microsoftJsonDateMatch) {
    const parsedDate = new Date(Number(microsoftJsonDateMatch[1]));
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }
  const parsedDate = new Date(dateLike);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function formatScheduleDayInLosAngeles(dateLike: string | Date) {
  const parsedDate = parseScheduleDate(dateLike);
  if (!parsedDate) {
    return null;
  }
  return uscDayFormatter.format(parsedDate);
}

function formatScheduleTimeInLosAngeles(dateLike: string | Date) {
  const parsedDate = parseScheduleDate(dateLike);
  if (!parsedDate) {
    return null;
  }
  return uscTimeFormatter.format(parsedDate).replace(/\s+/g, "").toLowerCase();
}

function timesOverlap(firstStartTime: string, firstEndTime: string, secondStartTime: string, secondEndTime: string) {
  const firstStart = moment(firstStartTime, "hh:mma");
  const firstEnd = moment(firstEndTime, "hh:mma");
  const secondStart = moment(secondStartTime, "hh:mma");
  const secondEnd = moment(secondEndTime, "hh:mma");

  if (!firstStart.isValid() || !firstEnd.isValid() || !secondStart.isValid() || !secondEnd.isValid()) {
    return false;
  }

  return firstStart.isBefore(secondEnd) && secondStart.isBefore(firstEnd);
}

export async function getCurrentSchedule(): Promise<Schedule | null> {
  const data = await fetch("https://webreg.usc.edu/Calendar");
  const text = await data.text();
  const syncScript = text.split("<script>kendo.syncReady")[1]?.split("\n")[0];
  if (!syncScript) {
    return null;
  }
  // there's a json object of the form "data":{"Data" that we want to parse
  const json = syncScript.split('data":{"Data":')[1]?.split("]")[0];
  if (json) {
    const dataObject = JSON.parse(`{"Data":${json}]}`) as Schedule;
    return dataObject;
  }
  return null;
}

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
  if (!data || !data.Data || !data.Data.length) {
    return;
  }
  const currentScheduleArr: {
    day: string[];
    time: string[];
    section: string;
    classname: string;
  }[] = [];
  for (const singleClass of data.Data) {
    const startDay = formatScheduleDayInLosAngeles(singleClass.Start);
    const startTime = formatScheduleTimeInLosAngeles(singleClass.Start);
    const endTime = formatScheduleTimeInLosAngeles(singleClass.End);
    if (!startDay || !startTime || !endTime) {
      continue;
    }
    const classInfo = singleClass.Title.split(" ");
    const [className, sectionName] = classInfo;
    if (!className || !sectionName) {
      continue;
    }
    const time = {
      day: [startDay],
      time: [startTime, endTime],
      section: sectionName.slice(1, -2),
      classname: className,
    };
    currentScheduleArr.push(time);
  }
  //bail if no classes
  if (currentScheduleArr.length === 0) {
    return;
  }
  //Iterate over every div. The layout of webreg is alternating divs for class name/code and then its content
  $(".accordion-content-area").each(function () {
    let doAllSectionsOverlap = true;
    const sections = $(this).find(".section");

    sections.each(function () {
      try {
        const rows = $(this).find(".section_row").toArray();
        //Get hours for current section
        const secHours = rows
          .find((r) => r.innerText.includes("Time:"))
          ?.innerText?.replace("Time: ", "")
          ?.trim()
          ?.split("-");
        if (!secHours) {
          return;
        }
        //Get days for class for current section
        let secDays = rows.find((r) => r.innerText.includes("Days:"))?.innerText;
        secDays = secDays?.replace("Days: ", "")?.trim();
        const days = splitDays(secDays);
        //Get section name to compare if you already have that class
        let secName = rows.find((r) => r.innerText.includes("Section:"))?.innerText;
        secName = secName?.replace("Section: ", "")?.trim() || "";
        //Get section name to compare if you already have that class

        for (const currClass of currentScheduleArr) {
          if (secName.startsWith(currClass.section)) {
            continue;
          }
          for (const currClassDay of currClass.day) {
            const secDay = days.find((d) => d === currClassDay);
            if (!secDay) {
              continue;
            }
            const [currentStartTime, currentEndTime] = currClass.time;
            const [sectionStartTime, sectionEndTime] = secHours;
            if (!currentStartTime || !currentEndTime || !sectionStartTime || !sectionEndTime) {
              continue;
            }
            //Class already registered/scheduled
            if (timesOverlap(currentStartTime, currentEndTime, sectionStartTime, sectionEndTime)) {
              addConflictOverlay(this, currClass.classname);
              return;
            }
          }
        }
        let secType = rows.find((r) => r.innerText.includes("Type:"))?.innerText;
        secType = secType?.replace("Type: ", "")?.trim();
        if (secType?.startsWith("Lecture")) {
          doAllSectionsOverlap = false;
        }
      } catch (e) {
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
