import ratings from "@/data/ratings.json" with { type: "json" };
import $ from "jquery";

type Rating = (typeof ratings)[number];
const professorRatings = new Map<string, Rating[]>();
export const ratingURLTemplate = "https://www.ratemyprofessors.com/professor/";
for (const professor of ratings) {
  const nameClean = getCleanName(`${professor.firstName} ${professor.lastName}`);
  const professorsEntryForName = professorRatings.get(nameClean) || [];
  professorsEntryForName.push(professor);
  professorRatings.set(nameClean, professorsEntryForName);
}

export function getCleanName(name: string) {
  return name.toLowerCase().replace(/[^a-zA-Z]/gi, "");
}
export const getProfessorRatings = (professorName: string) => {
  const rating = professorRatings.get(getCleanName(professorName));
  if (rating) {
    return rating;
  }
  // try some fallbacks now
  const name = professorName.split(" ");
  const fallbackRating = professorRatings.get(getCleanName(`${name[0]} ${name[name.length - 1]}`));
  return fallbackRating;
};
function insertProfessorRating(row: HTMLElement, professors: Rating[]) {
  for (const prof of professors) {
    $(row).find(`.id-${prof.legacyId}`).remove();
    const url = ratingURLTemplate + prof.legacyId;
    //To prevent reinserting, or if there are multiple professors, we insert an anchor with a rating class
    //if there already is one then we know it's another professor
    if ($(row).find(".rating").length !== 0) {
      $(row)
        .find(".rating")
        .after(`, <a class="id-${prof.legacyId}" href=${url}>${prof.avgRating || "Link"}</a>`);
    } else {
      $(row).addClass("blank_rating");
      //long string but needs to be exactly formatted
      const rows = $(row).find(".section_row").toArray();
      const instructorRow = rows.find((r) => r.innerText.includes("Instructor"));
      //actual contents of rating
      // If you want the rating on the page, just delete the string above and rename the one below this comment to
      // rating_anchor
      const rating_anchor_with_score = `<a class="rating id-${prof.legacyId}" href=${url} target="_blank">${prof.avgRating || "Link"}</a>`;
      const rating_anchor = rating_anchor_with_score;
      if (instructorRow) {
        //long string just to include new
        $(instructorRow).after(
          `<span class="usc-helper-rating-cell hours_alt1 text-md-center col-xs-12 col-sm-12 col-md-1 col-lg-1"><span class="hidden-lg hidden-md hidden-visible-xs-* visible-sm-* table-headers-xsmall">Prof. Rating: </span>${rating_anchor}</span>`,
        );
      }
      /* Very specific edge case - if you have two professors and you could not find the first, it'll insert an empty cell. However, if you can
               find the second you still want his score to be visible, so we need to remove the previously inserted blank one */
      if ($(row).find(".empty_rating").length !== 0) {
        $(row).find(".empty_rating")[0]?.remove();
      }
    }
  }
}

export function parseProfessor(instructors: string[], row: HTMLElement) {
  const instructorsNameParts = instructors.map((instructor) => instructor.split(/[, ]/).filter(Boolean));
  //generate actual name
  const professors = instructorsNameParts.flatMap((nameParts) => {
    const nameWithoutLastPart = nameParts.slice(0, -1);
    const lastNameFirst = `${nameParts[1]} ${nameParts[0]}`;
    const lastPartFirst = [nameParts[nameParts.length - 1], ...nameWithoutLastPart].join(" ");
    const reversedRemainingParts = [...nameWithoutLastPart].reverse().join(" ");

    return (
      professorRatings.get(getCleanName(lastNameFirst)) ??
      professorRatings.get(getCleanName(lastPartFirst)) ??
      professorRatings.get(getCleanName(reversedRemainingParts)) ??
      []
    );
  });
  //If instructor name in json
  if (professors && professors.length) {
    insertProfessorRating(row, professors);
  } else {
    insertBlankRatingCell(row);
  }
}
export function splitDays(days: string | undefined) {
  if (!days) {
    return [];
  }
  //Split Thursday first because otherwise it'll get split on Tuesday
  const split = days.replace("Th", "D").split("");
  for (let i = 0; i < split.length; i++) {
    switch (split[i]) {
      case "M":
        split[i] = "Monday";
        break;
      case "T":
        split[i] = "Tuesday";
        break;
      case "W":
        split[i] = "Wednesday";
        break;
      case "D":
        split[i] = "Thursday";
        break;
      case "F":
        split[i] = "Friday";
        break;
    }
  }
  return split;
}
export interface Options {
  enabled: boolean;
  showConflicts: boolean;
  showUnits: boolean;
}
export const emptySpanCell =
  '<span class="usc-helper-rating-cell instr_alt1 empty_rating col-xs-12 col-sm-12 col-md-1 col-lg-1"><span \
    class="hidden-lg hidden-md visible-xs-* visible-sm-* table-headers-xsmall">Prof. Rating: </span></span>';

export function insertBlankRatingCell(row: HTMLElement | JQuery<HTMLElement>) {
  //blank rating is if you can not find the professor in the json - we still need something in that cell
  //Looking back it might be better if I add the cell in before hand no matter what, and then only change it's inner
  // html if it's a valid professor... TODO refactor for next semester I suppose
  if (!$(row).hasClass("blank_rating")) {
    $(row).addClass("blank_rating");
    const rows = $(row).find(".section_row").toArray();
    const instructorRow = rows.find((r) => r.innerText.includes("Instructor"));
    if (instructorRow) {
      $(instructorRow).after(emptySpanCell);
    }
  }
}
export const baseClassInfo = {
  //Total spots is all lecture and lecture-lab spots (sum of 2nd # in "# of #"), avail able is first
  classTotalSpots: 0,
  classAvailableSpots: 0,
  //This is for sections (such as BIO) which have classes that are labs only. Its the running total of ALL "# of #", but
  // only displayed if isOnlyLabSections is true
  classTotalSpotsLabOnly: 0,
  classAvailableSpotsLabOnly: 0,
  //This is for when a class is closed - it'll let you know how many spots are open based on discussion
  classDiscussionTotalSpots: 0,
  classDiscussionAvailableSpots: 0,
  /*Initialize isOnlyLabSections to true - will get set to false if type of class is ever anything but Lab
 We are usually only interested in Lecture and Lecture-Lab, but some classes *only* have Labs - these are still interesting
 to Bio kids and whatnot. So we'll save all of them, and only display either the Lecture-ish ones or, if it's all Bio, then display totals
 */
  isOnlyLabSections: true,
  //Checks whether all lecture sections are closed
  allLecturesClosed: false,
  //If it has ANY lecture sections
  classHasLectureSection: false,
  currentSectionHasDiscussion: false,
  //Is the current class closed for registration?
  currectSectionIsClosed: false,
};

export function isNumber(n: number) {
  return Number.isFinite(n);
}

export type ClassInfo = typeof baseClassInfo;
