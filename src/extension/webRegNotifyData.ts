import type { NotifyButtonData } from "@/extension/notifyButtonData";

function sectionNumber(value: string | null | undefined) {
  return value?.trim().match(/^(\d{5})(?:\s*[RD])?$/i)?.[1];
}

function getSectionNumber(section: Element) {
  const containerId = section.id.match(/^section_(\d{5})$/)?.[1];
  if (containerId) {
    return containerId;
  }

  // Labs and CourseBin rows can have no registration form. Their visible
  // Section cell still identifies the selected offering, including leading zeros.
  for (const row of section.querySelectorAll(".section_row")) {
    const match = row.textContent?.trim().match(/^Section\s*:\s*(\d{5})(?:\s*[RD])?$/i);
    if (match) {
      return match[1];
    }
  }

  for (const input of section.querySelectorAll<HTMLInputElement>("input")) {
    if (input.id.toLowerCase() === "sectionid" || input.name.toLowerCase() === "sectionid") {
      const id = sectionNumber(input.value);
      if (id) {
        return id;
      }
    }
  }

  for (const action of section.querySelectorAll("[data-ajax-url]")) {
    const url = action.getAttribute("data-ajax-url") || "";
    const id = url.match(/\/api\/section\/\d{5}\/(\d{5})(?:[/?#]|$)/i)?.[1];
    if (id) {
      return id;
    }
  }
}

export function getWebRegNotifyData(section: Element, semester: string): NotifyButtonData | null {
  const sectionId = getSectionNumber(section);
  // Resolve the course from the section's own panel, never from another
  // section's form or from prerequisite course codes elsewhere in the panel.
  const panel = section.closest(".accordion-content-area");
  const courseText = panel?.previousElementSibling?.querySelector(".crsID")?.textContent;
  const course = courseText?.trim().match(/^([A-Z]{2,5})[-\s]+(\d+[A-Z]*)\b/i);
  if (!sectionId || !course) {
    return null;
  }

  return {
    sectionId,
    department: course[1]!,
    fullCourseId: `${course[1]}-${course[2]}`,
    semester,
  };
}
