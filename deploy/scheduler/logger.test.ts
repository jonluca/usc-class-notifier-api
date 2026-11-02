import assert from "node:assert/strict";
import test from "node:test";
import { createSchedulerLogger } from "./logger.ts";

test("scheduler library logger emits fixed categories and never message, stack, metadata or credentials", () => {
  const entries: string[] = [];
  const logger = createSchedulerLogger((entry) => entries.push(entry));
  const sensitive = "recipient@example.invalid token=synthetic-secret +12125551234 SELECT private_value";
  logger.info(sensitive, { secret: sensitive });
  logger.debug(sensitive);
  assert.equal(entries.length, 0);
  logger.warn(sensitive, { secret: sensitive });
  logger.error(new Error(sensitive), sensitive);
  logger.error(sensitive, new DOMException(sensitive, "AbortError"));
  logger.error(new DOMException(sensitive, "TimeoutError"));
  logger.error(new TypeError(sensitive));
  assert.deepEqual(
    entries.map((entry) => JSON.parse(entry)),
    [
      { event: "usc_scheduler_library_log", level: "warn", category: "warning" },
      { event: "usc_scheduler_library_log", level: "error", category: "error" },
      { event: "usc_scheduler_library_log", level: "error", category: "abort" },
      { event: "usc_scheduler_library_log", level: "error", category: "timeout" },
      { event: "usc_scheduler_library_log", level: "error", category: "type_error" },
    ],
  );
  assert.equal(entries.join("\n").includes(sensitive), false);
});
