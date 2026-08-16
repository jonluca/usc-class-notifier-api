import assert from "node:assert/strict";
import test from "node:test";
import { TRPCError } from "@trpc/server";
import {
  assertMatchingClassInfo,
  assertMonitoredSemester,
  notificationSemesterSchema,
} from "@/server/api/notificationSignup";

test("notification semester schema accepts only five-digit USC term codes", () => {
  for (const semester of ["20261", "20262", "20263"]) {
    assert.equal(notificationSemesterSchema.parse(semester), semester);
  }

  for (const semester of ["", "2026", "20260", "20264", "202620261", "Fall 2026"]) {
    const result = notificationSemesterSchema.safeParse(semester);
    assert.equal(result.success, false, semester);
    if (!result.success) {
      assert.match(result.error.issues[0]?.message || "", /five-digit USC term code/);
    }
  }
});

test("allows a semester only when the notification worker monitors it", () => {
  assert.doesNotThrow(() => assertMonitoredSemester("20263", ["20262", "20263"]));

  assert.throws(
    () => assertMonitoredSemester("20261", ["20262", "20263"]),
    (error) =>
      error instanceof TRPCError &&
      error.code === "BAD_REQUEST" &&
      error.message ===
        "Semester 20261 is not currently monitored. Refresh the page and choose a current registration term.",
  );
});

test("rejects a section that has no ClassInfo row for the selected semester", () => {
  assert.doesNotThrow(() => assertMatchingClassInfo({ id: "class-id" }, "37905", "20263"));

  assert.throws(
    () => assertMatchingClassInfo(null, "37905", "20263"),
    (error) =>
      error instanceof TRPCError &&
      error.code === "BAD_REQUEST" &&
      error.message === "Section 37905 was not found in semester 20263. Refresh the page and select the section again.",
  );
});
