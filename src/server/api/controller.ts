import { prisma } from "@/server/db";
import logger from "@/server/logger";
import pMap from "p-map";
import { uniq } from "lodash-es";
import { notifyAvailableSections, type AvailabilityPage } from "@/server/api/availabilityNotifications.ts";
import {
  FALL_REGISTRATION_RANGE,
  getValidSemesters,
  SPRING_REGISTRATION_RANGE,
  SUMMER_REGISTRATION_RANGE,
} from "@/utils/semester";
import { getCurrentAvailableCourses, searchClasses } from "@/server/api/usc-api.ts";
import type { ClassInfoRefreshData } from "@/server/api/classInfoRefresh.ts";
import { saveCatalogSections } from "@/server/api/catalogRefreshWrites.ts";
import { isProd } from "@/constants.ts";

export const runAvailabilityDepartment = async (department: string, semester: string, page: AvailabilityPage = {}) => {
  const result = await searchClasses({ searchTerm: department, semester });
  if (!result?.courses) {
    throw new Error("USC department availability response is missing courses");
  }
  return notifyAvailableSections(department, semester, result.courses, page);
};

const checkForAvailabilityForDepartment = async (department: string, semester: string) => {
  try {
    await runAvailabilityDepartment(department, semester);
  } catch (error) {
    console.error(error);
  }
};

export const runRefresh = async () => {
  const semesters = getValidSemesters();

  for (const semester of semesters) {
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1; // getMonth is zero-indexed

    // we only want to run the refresh during months where users can actually register for classes - no point in checking after February 14th for the Spring semester, for instance
    // so for spring semester, only run from October to February
    // for fall semester, only run from March to September
    // for summer semester, only run from March to July
    try {
      const isSpring = semester.endsWith("1");
      const isSummer = semester.endsWith("2");
      const isFall = semester.endsWith("3");
      if (isSpring && !SPRING_REGISTRATION_RANGE.includes(currentMonth)) {
        console.debug(`Skipping refresh for spring semester ${semester} in month ${currentMonth}`);
        continue;
      }
      if (isFall && !FALL_REGISTRATION_RANGE.includes(currentMonth)) {
        console.debug(`Skipping refresh for fall semester ${semester} in month ${currentMonth}`);
        continue;
      }
      if (isSummer && !SUMMER_REGISTRATION_RANGE.includes(currentMonth)) {
        console.debug(`Skipping refresh for summer semester ${semester} in month ${currentMonth}`);
        continue;
      }
      await refreshSemester(semester);
    } catch (e: any) {
      console.error(`Error refreshing semester ${semester}: ${e}`);
    }
  }
};

export const getAvailabilityDepartments = async (semester: string): Promise<string[]> => {
  const departments = await prisma.$queryRaw<{ department: string }[]>`
    SELECT DISTINCT COALESCE(class_info.prefix, class_info.department) AS department
    FROM "ClassInfo" AS class_info
    WHERE class_info.section IN (
      SELECT DISTINCT watched_section.section
      FROM "WatchedSection" AS watched_section
      WHERE watched_section.semester = ${semester}
        AND watched_section.notified = false
        AND watched_section."cancelledAt" IS NULL
    )
      AND class_info.semester = ${semester}
  `;

  return departments.map((row) => row.department);
};

const refreshSemester = async (semester: string) => {
  const departments = await getAvailabilityDepartments(semester);
  await pMap(departments, (department) => checkForAvailabilityForDepartment(department, semester), {
    concurrency: 5,
    stopOnError: false,
  });
};

export const getCatalogDepartments = async (semester: string): Promise<string[]> => {
  const courses = await getCurrentAvailableCourses({ semester });
  if (!courses?.courses) {
    throw new Error("USC catalog response is missing courses");
  }
  return uniq(courses.courses.map((course) => course.prefix));
};

export const refreshCatalogDepartment = async (
  department: string,
  semester: string,
  options: { capturedAt?: number } = {},
): Promise<{ changedSections: number }> => {
  const capturedAt = options.capturedAt ?? Date.now();
  const searchResults = await searchClasses({ searchTerm: department, semester });
  if (!searchResults?.courses) {
    throw new Error("USC department catalog response is missing courses");
  }
  const departmentCourses = searchResults.courses.filter((c) => c.prefix === department);
  const sectionInfos: ClassInfoRefreshData[] = [];
  for (const course of departmentCourses) {
    if (!course.sections) {
      continue;
    }
    for (const section of course.sections) {
      try {
        const sectionNumber = section.sisSectionId;
        const instructorNames = (section.instructors || [])
          .map((inst) => [inst.firstName, inst.lastName].filter(Boolean).join(" "))
          .join(", ");
        const sectionInfo = {
          department: course.prefix,
          section: String(sectionNumber),
          courseNumber:
            course.scheduledCourseCode?.courseHyphen ||
            course.publishedCourseCode?.courseHyphen ||
            course.fullCourseName ||
            "",
          courseTitle: course.name,
          prefix: course.prefix,
          semester,
          instructor: instructorNames,
          type: section.rnrMode,
          units: (section.units || []).join("-"),
          day: (section.schedule || [])
            .map((l) => l.dayCode)
            .filter(Boolean)
            .join(""),
          location: uniq((section.schedule || []).map((l) => l.location).filter(Boolean)).join(", "),
          hasDClearance: Boolean(section.hasDClearance),
          isCancelled: section.isCancelled,
        } satisfies ClassInfoRefreshData;
        sectionInfos.push(sectionInfo);
      } catch (e) {
        console.error(
          `Error processing section ${section.sisSectionId} for course ${course.fullCourseName} in department ${department} for semester ${semester}: ${e}`,
        );
      }
    }
  }
  const changedSections = await saveCatalogSections(prisma, semester, sectionInfos, capturedAt);
  return { changedSections };
};

export const createClassInfo = async () => {
  for (const semester of getValidSemesters()) {
    try {
      const departments = await getCatalogDepartments(semester);
      await pMap(
        departments,
        async (department) => {
          try {
            await refreshCatalogDepartment(department, semester);
            console.log(`Finished ${semester} - ${department}`);
          } catch (error) {
            console.error(`Error creating class info for ${department} in ${semester}`, error);
          }
        },
        { concurrency: isProd ? 4 : 1, stopOnError: false },
      );
    } catch (error) {
      console.error(error);
    }
  }
  logger.info("Finished creating class info");
};
