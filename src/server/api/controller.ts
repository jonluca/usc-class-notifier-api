import { prisma } from "@/server/db";
import logger from "@/server/logger";
import pMap from "p-map";
import { uniq } from "lodash-es";
import { notifyAvailableSections } from "@/server/api/availabilityNotifications.ts";
import {
  FALL_REGISTRATION_RANGE,
  getValidSemesters,
  SPRING_REGISTRATION_RANGE,
  SUMMER_REGISTRATION_RANGE,
} from "@/utils/semester";
import { getCurrentAvailableCourses, searchClasses } from "@/server/api/usc-api.ts";
import {
  classInfoRefreshSelect,
  getChangedClassInfo,
  type ClassInfoRefreshData,
} from "@/server/api/classInfoRefresh.ts";
import { isProd } from "@/constants.ts";

const checkForAvailabilityForDepartment = async (department: string, semester: string) => {
  try {
    const departmentCourses = await searchClasses({
      searchTerm: department,
      semester,
    });

    if (departmentCourses?.courses) {
      await notifyAvailableSections(department, semester, departmentCourses.courses);
    }
  } catch (e) {
    console.error(e);
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

const refreshSemester = async (semester: string) => {
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

  if (!departments.length) {
    return;
  }
  await pMap(
    departments,
    async (department) => {
      await checkForAvailabilityForDepartment(department.department, semester);
    },
    {
      concurrency: 5,
      stopOnError: false,
    },
  );
};

export const createClassInfo = async () => {
  const semesters = getValidSemesters();

  for (const semester of semesters) {
    try {
      const courses = await getCurrentAvailableCourses({ semester });
      if (!courses) {
        continue;
      }
      const departments = uniq(courses.courses.map((course) => course.prefix));

      await pMap(
        departments,
        async (department) => {
          try {
            const searchResults = await searchClasses({
              searchTerm: department,
              semester,
            });
            // now iterate over the classes, and create class info entries for each section in the department
            if (!searchResults || !searchResults.courses) {
              console.error(`No search results for department ${department} in semester ${semester}`);
              return;
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

            for await (const sectionInfo of getChangedClassInfo(sectionInfos, (sectionNumbers) =>
              prisma.classInfo.findMany({
                where: { semester, section: { in: sectionNumbers } },
                select: classInfoRefreshSelect,
              }),
            )) {
              try {
                await prisma.classInfo.upsert({
                  where: { section_semester: { section: sectionInfo.section, semester } },
                  create: sectionInfo,
                  update: sectionInfo,
                  select: { id: true },
                });
              } catch (e) {
                console.error(
                  `Error saving section ${sectionInfo.section} in department ${department} for semester ${semester}: ${e}`,
                );
              }
            }

            console.log(`Finished ${semester} - ${department}`);
          } catch (e: any) {
            console.error(`Error creating class info for ${department} in ${semester}: ${e.message}`);
          }
        },
        {
          concurrency: isProd ? 4 : 1,
          stopOnError: false,
        },
      );
    } catch (e) {
      console.error(e);
    }
  }
  logger.info("Finished creating class info");
};
