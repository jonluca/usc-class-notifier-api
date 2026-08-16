import assert from "node:assert/strict";
import test from "node:test";
import { syncNotifyButtonDataset } from "@/extension/notifyButtonData";

test("updates a reused SPA notify button to the newly selected term", () => {
  const dataset: DOMStringMap = {
    sectionId: "10000",
    department: "OLD",
    fullCourseId: "OLD 100",
    semester: "20261",
  };

  syncNotifyButtonDataset(dataset, {
    sectionId: "37905",
    department: "IR",
    fullCourseId: "IR 384",
    semester: "20263",
  });

  assert.deepEqual(dataset, {
    sectionId: "37905",
    department: "IR",
    fullCourseId: "IR 384",
    semester: "20263",
  });
});

test("removes stale optional data when the current page cannot provide it", () => {
  const dataset: DOMStringMap = {
    sectionId: "37905",
    department: "IR",
    fullCourseId: "IR 384",
    semester: "20261",
  };

  syncNotifyButtonDataset(dataset, {
    sectionId: "37905",
    department: "IR",
    fullCourseId: undefined,
    semester: undefined,
  });

  assert.deepEqual(dataset, {
    sectionId: "37905",
    department: "IR",
  });
});
