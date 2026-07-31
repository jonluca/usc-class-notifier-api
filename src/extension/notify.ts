import $ from "jquery";
import { context } from "@/extension/context";
import { getCurrentTerm } from "@/extension/getCurrentTerm";
import { type NotifyButtonData, syncNotifyButtonDataset } from "@/extension/notifyButtonData";

const COURSE_ID_PATTERN = /\b([A-Z]{2,5}\s+\d+[A-Z]?)\b/;

function createWebRegNotifyButton() {
  return $(`<input name="submit" value="Notify Me" class="btn btn-default addtomycb col-xs-12 notify" type="button">`);
}

function getPageSemester() {
  return getCurrentTerm();
}

function getDepartmentFromCourseId(fullCourseId?: string) {
  return fullCourseId?.split(/\s+/)[0] || "";
}

function getCourseIdFromText(text: string | null | undefined) {
  return text?.replace(/\s+/g, " ").match(COURSE_ID_PATTERN)?.[1];
}

function getClassesPageButtonData(trigger: HTMLElement): NotifyButtonData | null {
  const sectionId = trigger.dataset.sectionId?.trim();
  const department = trigger.dataset.department?.trim();

  if (!sectionId || !department) {
    return null;
  }

  return {
    sectionId,
    department,
    fullCourseId: trigger.dataset.fullCourseId?.trim() || undefined,
    semester: trigger.dataset.semester?.trim() || undefined,
  };
}

function getClassesPageRowData(trigger: HTMLElement): NotifyButtonData | null {
  const row = $(trigger).closest("mat-row, tr")[0];
  if (!row) {
    return null;
  }

  const cells = $(row).find("mat-cell, td").toArray();
  const sectionId = (cells[0]?.textContent || "").replace(/\D/g, "");
  if (!sectionId) {
    return null;
  }

  let current: HTMLElement | null = row;
  let fullCourseId: string | undefined;

  while (current && !fullCourseId) {
    fullCourseId = getCourseIdFromText(current.textContent);
    current = current.parentElement;
  }

  return {
    sectionId,
    fullCourseId,
    department: getDepartmentFromCourseId(fullCourseId),
    semester: getPageSemester(),
  };
}

function setSelectedClass(data: NotifyButtonData | null) {
  if (!data?.sectionId || !data.department) {
    context.getState().setSelectedClass({ isInvalid: true });
    return;
  }

  context.getState().setSelectedClass(data);
}

export function createClassesPageNotifyButton(data: NotifyButtonData) {
  const button = $("<button>", {
    type: "button",
    text: "Notify Me",
    class: "notify usc-helper-notify-button",
  });

  const buttonElement = button[0];
  if (buttonElement) {
    syncNotifyButtonDataset(buttonElement.dataset, data);
  }

  return button;
}

export function addNotifyMe(section: HTMLElement) {
  const hasNotifyMe = $(section).find(".notify");
  if (hasNotifyMe.length !== 0) {
    return;
  }
  const addToCourseBinSection = $(section).find(".btnAddToMyCourseBin");
  if (addToCourseBinSection.length) {
    addToCourseBinSection.append(createWebRegNotifyButton());
    return;
  }

  const fallbackContainer = $("<div>", {
    class: "btnAddToMyCourseBin usc-helper-webreg-notify-container",
  }).css({
    width: "12%",
    float: "right",
  });

  fallbackContainer.append(createWebRegNotifyButton());
  $(section).append(fallbackContainer);
}

// add an event listener for any .notify on document
$(document).on("click", ".notify", function () {
  try {
    const classesPageButtonData = getClassesPageButtonData(this);
    if (classesPageButtonData) {
      setSelectedClass(classesPageButtonData);
      return;
    }

    const section = $(this).closest(".section")[0];
    if (!section) {
      setSelectedClass(getClassesPageRowData(this));
      return;
    }
    const form = $(section).find("form")[0];
    const strings = form?.attributes?.getNamedItem("data-ajax-url")?.textContent?.split("/");
    let id = strings?.[4];
    if (!id) {
      // try and find the id from the parent
      const parent = $(this).closest(".section_crsbin");
      if (parent) {
        const rows = $(parent).find(".section_row").toArray();
        const sectionRow = rows.find((r) => r.innerText.includes("Section"));
        if (sectionRow) {
          // replace any non number characters
          const section = sectionRow.innerText.replace(/\D/g, "");
          if (section) {
            id = section;
          }
        }
      }
    }
    if (!id && form) {
      const inputs = $(form).find("input");
      const sectionInput = inputs.toArray().find((i) => i.id === "sectionid" || i.name === "sectionid");
      if (sectionInput) {
        id = sectionInput.value;
      }
    }
    const titleTopbar = form ? $(form).parents(".accordion-content-area") : $();
    const header = $(titleTopbar).prev();
    //get the department by matching form ID to the row above
    const courseSearch = $(header).find(".crsID");
    let departmentFromAbove = "";
    if (courseSearch.length) {
      const spanElem = courseSearch.first().text();
      const departmentString = spanElem.split("-");
      departmentFromAbove = departmentString[0] ?? "";
    }

    let fullCourseId;
    if (titleTopbar) {
      const header = $(titleTopbar).prev();
      const text = $(header).find(".crsID").text();
      if (text) {
        const splitcrsId = text.split("-");
        fullCourseId = text.split(" ")[0];
        if (splitcrsId[0] && !departmentFromAbove) {
          departmentFromAbove = splitcrsId[0];
        }
      }
    }
    const semester = getPageSemester();
    if (!id) {
      context.getState().setSelectedClass({ isInvalid: true });
      return;
    }
    // we need to construct the class object by pulling info from the section
    const classData = { sectionId: id, fullCourseId, department: departmentFromAbove, semester };
    context.getState().setSelectedClass(classData);
  } catch (e) {
    console.error(e);
    context.getState().setSelectedClass({ isInvalid: true });
  }
});
