import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { getValidSemesters, SEMESTER_CODE_PATTERN } from "@/utils/semester";

export const notificationSemesterSchema = z
  .string()
  .regex(SEMESTER_CODE_PATTERN, "Semester must be a five-digit USC term code such as 20263.");

export function assertMonitoredSemester(semester: string, monitoredSemesters: readonly string[] = getValidSemesters()) {
  if (!SEMESTER_CODE_PATTERN.test(semester)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Semester must be a five-digit USC term code such as 20263.",
    });
  }

  if (!monitoredSemesters.includes(semester)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Semester ${semester} is not currently monitored. Refresh the page and choose a current registration term.`,
    });
  }
}

export function assertMatchingClassInfo<T extends { id: string; isCancelled?: boolean }>(
  classInfo: T | null | undefined,
  sectionNumber: string,
  semester: string,
): asserts classInfo is T {
  if (classInfo?.isCancelled) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Section ${sectionNumber} is cancelled.` });
  }
  if (!classInfo) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Section ${sectionNumber} was not found in semester ${semester}. Refresh the page and select the section again.`,
    });
  }
}
