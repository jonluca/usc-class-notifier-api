import $ from "jquery";
import { changeCSSColumnWidth } from "@/extension/style";
import type { ClassInfo, Options } from "@/extension/utils";
import { isNumber } from "@/extension/utils";
import { baseClassInfo } from "@/extension/utils";
import { parseProfessor } from "@/extension/utils";
import { insertBlankRatingCell } from "@/extension/utils";
import { emptySpanCell } from "@/extension/utils";
import { addNotifyMe } from "@/extension/notify";
import { insertClosedRegistration, insertOnlyLabNumbers, insertTotalSpots } from "./insert-class-info";

function addUnitsToTitle(row: HTMLElement) {
  const headerText = $(row).prev().find(".course-title-indent");
  headerText.find(".usc-helper-units").remove();

  // get units
  const sections = $(row).find(".section");
  if (sections.length === 0) {
    return;
  }
  for (const section of sections) {
    const rows = $(section).find(".section_row");

    // 3 is because the header has two elements that start with type_alt
    if (rows.length > 3) {
      const unitsRow = $(rows)[3];
      if (!unitsRow) {
        continue;
      }
      let actualUnits = unitsRow.innerText;
      actualUnits = actualUnits.replace("Units: ", "").trim();
      if (actualUnits.trim() === "0.0") {
        continue;
      }
      const unitText = `<span class="usc-helper-units crsTitl"> - ${actualUnits} units</span>`;
      headerText.append(unitText);
      return;
    }
  }
}

function insertProfRatingHeader(header: JQuery<HTMLElement>) {
  if (!header) {
    return;
  }
  const rows = $(header).find(".section_row");
  const instructorRow = rows.toArray().find((r) => r.innerText.includes("Instructor")) || rows[7];
  if (instructorRow && $(header).find(".usc-helper-rating-header").length === 0) {
    $(instructorRow).before(
      '<span class="usc-helper-rating-header section_row col-md-1 col-lg-1"><b>Prof. Rating</b></span>',
    );
  }
}

function changeAddToCourseBinButton(row: HTMLElement) {
  const addToCourseBin = $(row)
    .find(".addtomycb, .add-to-course-bin")
    .filter((i, el) => !$(el).hasClass("notify"));
  // filter out any with the notify class
  for (const button of addToCourseBin) {
    const element = $(button);
    if (!element.hasClass("usc-helper-modified-button")) {
      element
        .attr("data-usc-helper-original-value", element.attr("value") ?? "")
        .attr("data-usc-helper-original-text", element.text())
        .addClass("usc-helper-modified-button");
    }
    element.attr("value", "Add");
    element.text("Add");
  }
}

// TODO: Fix this function, as it does too many things that are unrelated
function addRegistrationNumbers(section: HTMLElement, enrolled: string, total: string, classInfo: ClassInfo) {
  //Gets each of ("# of #")
  //TODO: This utilizes global variables :( Sorry future person debugging this, I'll try to do a refactor before I
  // leave USC
  const currentEnrolled = parseInt(enrolled);
  const totalAvailable = parseInt(total);
  //Checks class type - we are only interested in Lecture and Lecture-Lab
  const rows = $(section).find(".section_row");
  if (!rows.length) {
    return;
  }
  const classTypeElem = rows.toArray().find((r) => r.innerText.includes("Type:"));
  let classType;
  if (classTypeElem) {
    classType = classTypeElem.textContent
      ?.trim()
      .replace(/\s+/gi, "")
      .split("Type:")
      .filter((l) => l.trim())[0];

    if (classType === "Lecture" || classType === "Lecture-Lab" || classType === "Lecture-Discussion") {
      //It's not a lab, so isOnlyLabSections is false
      classInfo.isOnlyLabSections = false;
      classInfo.classHasLectureSection = true;
      classInfo.classTotalSpots += totalAvailable;
      classInfo.classAvailableSpots += totalAvailable - currentEnrolled;
      classInfo.allLecturesClosed = false;
    } else if (classType === "Lab") {
      classInfo.classTotalSpotsLabOnly += totalAvailable;
      classInfo.classAvailableSpotsLabOnly += totalAvailable - currentEnrolled;
    } else if (classType === "Discussion") {
      classInfo.isOnlyLabSections = false;
      classInfo.currentSectionHasDiscussion = true;
      classInfo.classDiscussionTotalSpots += totalAvailable;
      classInfo.classDiscussionAvailableSpots += totalAvailable - currentEnrolled;
    } else {
      //If not Lab or Lecture/lecture-lab then set the flag to false
      classInfo.isOnlyLabSections = false;
    }
  }
}

//Each row (which corresponds to a single lecture/lab/discussion time) needs to be parsed for times and spots available
function parseRegistrationNumbers(section: HTMLElement, classInfo: ClassInfo) {
  //Find registration numbers for this row, formatted like "# of #". Hidden content also prepends it with Registered:
  // so that must be cut out
  const rows = $(section).find(".section_row");
  const regNumElem =
    rows.toArray().find((r) => r.innerText.includes("Registered:")) || $(section).find(".RegSeatCol")[0];
  let regNum;
  addNotifyMe(section);

  //Cut out hidden text before it
  //If class has reg details
  if (regNumElem) {
    regNum = (regNumElem.textContent || "").replace("Registered: ", "").trim();
    //create array using "of" as delimiter
    regNum = regNum.split("of");
    if (regNum.length !== 2) {
      classInfo.currectSectionIsClosed = true;
      if (regNum[0]?.trim() === "Closed" && !classInfo.classHasLectureSection) {
        classInfo.allLecturesClosed = true;
      }
      if (!$(section).hasClass("blank_rating")) {
        $(section).addClass("blank_rating");
        const rows = $(section).find(".section_row").toArray();
        const instructorRow = rows.find((r) => r.innerText.includes("Instructor"));
        if (instructorRow) {
          $(instructorRow).after(emptySpanCell);
        }
      }
    } else {
      const [enrolled, total] = regNum;
      if (enrolled && total) {
        addRegistrationNumbers(section, enrolled.trim(), total.trim(), classInfo);
      }
    }
  }
}

function parseSections(sections: JQuery<HTMLElement>, classInfo: ClassInfo) {
  $(sections).each(function () {
    try {
      //rename Add to myCourseBin button so that it fits/looks nice
      changeAddToCourseBinButton(this);
      parseRegistrationNumbers(this, classInfo);
      //Retrieve Instructor cell from row
      const rows = $(this).find(".section_row").toArray();
      const instructorRow = rows.find((r) => r.innerText.includes("Instructor"));

      if (!instructorRow) {
        //I don't think this code actually ever runs, as USC creates blank cells with that class if it's empty, but
        // better safe than sorry here. If in the future they change it this'll prevent it from looking misaligned
        insertBlankRatingCell(this);
        //jQuery way of saying continue;
        return;
      }
      //get all professor names in a hacky way
      const instructors = instructorRow.innerText.replace("Instructor:", "").trim();
      //split on line breaks
      const names = instructors
        .trim()
        .split("<br>")
        .filter(Boolean)
        .flatMap((l) => l.split("\n"))
        .map((l) => l.trim())
        .filter(Boolean);

      if (!names.length) {
        //I don't think this code actually ever runs, as USC creates blank cells with that class if it's empty, but
        // better safe than sorry here. If in the future they change it this'll prevent it from looking misaligned
        insertBlankRatingCell(this);
        //jQuery way of saying continue;
        return;
      }
      //single instructor name, comma delimited
      parseProfessor(names, this);
    } catch (e) {
      console.error(e);
      console.error(`Failed to parse row ${this}!`);
    }
  });
}

function insertClassNumbers(element: HTMLElement, classInfo: ClassInfo) {
  const {
    classTotalSpots,

    allLecturesClosed,
    classHasLectureSection,
    isOnlyLabSections,
    classTotalSpotsLabOnly,
  } = classInfo;

  //Normal insert for remaining spots
  if (classTotalSpots !== 0 && isNumber(classTotalSpots)) {
    insertTotalSpots(element, classInfo);
  }
  //If it's closed
  if (allLecturesClosed && !classHasLectureSection) {
    insertClosedRegistration(element, classInfo);
  }
  //if there were only labs in this class, show it
  if (isOnlyLabSections && classTotalSpotsLabOnly !== 0 && isNumber(classTotalSpotsLabOnly)) {
    insertOnlyLabNumbers(element, classInfo);
  }
}

function parseClasses(options: Options) {
  const classes = $(".accordion-content-area");

  $(classes).each(function () {
    try {
      const classInfo = { ...baseClassInfo };
      //set global variables to 0 (counts, class closed, class type, etc)
      if (options.showUnits) {
        addUnitsToTitle(this);
      }
      //Insert Prof Rating column at top of each class view
      const header = $(this).find(".section_head");
      insertProfRatingHeader(header);
      //Iterate over every section in row. To get alternating colors, USC uses alt0 and alt1, so we must search for both
      const sections = $(this).find(".section_crsbin");
      parseSections(sections, classInfo);
      //If total spots is a number and it's not 0, insert
      insertClassNumbers(this, classInfo);
    } catch (e) {
      console.error(e);
      console.error("Failed to parse a class!");
    }
  });
}

export function parseWebRegPage(options: Options) {
  changeCSSColumnWidth();
  parseClasses(options);
}
