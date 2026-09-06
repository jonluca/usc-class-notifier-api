import assert from "node:assert/strict";
import test from "node:test";
import { getChangedClassInfo, type ClassInfoRefreshData } from "./classInfoRefresh.ts";

const sectionInfo: ClassInfoRefreshData = {
  section: "30001",
  semester: "20263",
  department: "CSCI",
  prefix: "CSCI",
  courseNumber: "CSCI-104",
  courseTitle: "Data Structures",
  instructor: "Ada Lovelace",
  type: "Lecture",
  units: "4",
  day: "MW",
  location: "SAL 101",
  hasDClearance: false,
  isCancelled: false,
};

async function collectChanges(
  sections: ClassInfoRefreshData[],
  findExisting: (sectionNumbers: string[]) => Promise<ClassInfoRefreshData[]>,
) {
  const writes: ClassInfoRefreshData[] = [];
  for await (const section of getChangedClassInfo(sections, findExisting)) {
    writes.push(section);
  }
  return writes;
}

test("a 1,200-section unchanged refresh replaces 1,200 upserts with five bounded reads and no writes", async () => {
  const sections = Array.from({ length: 1_200 }, (_, index) => ({ ...sectionInfo, section: String(30_000 + index) }));
  const existing = new Map(sections.map((section) => [section.section, section]));
  const readSizes: number[] = [];
  const writes = await collectChanges(sections, async (sectionNumbers) => {
    readSizes.push(sectionNumbers.length);
    return sectionNumbers.map((section) => {
      const row = existing.get(section);
      assert.ok(row);
      return { ...row };
    });
  });
  assert.deepEqual(readSizes, [250, 250, 250, 250, 200]);
  assert.deepEqual(writes, []);
});

test("only changed or missing sections are sent to the upsert loop", async () => {
  const unchanged = { ...sectionInfo };
  const changed = { ...sectionInfo, section: "30002", instructor: "Grace Hopper" };
  const added = { ...sectionInfo, section: "30003" };
  const writes = await collectChanges([unchanged, changed, added], async () => [
    unchanged,
    { ...changed, instructor: "Former Instructor" },
  ]);
  assert.deepEqual(writes, [changed, added]);
});

test("detects changes to all refreshed catalog fields including nullable values and clearance", async () => {
  const changes: Partial<ClassInfoRefreshData>[] = [
    { department: "EE" },
    { prefix: "EE" },
    { courseNumber: "CSCI-170" },
    { courseTitle: "Discrete Methods" },
    { instructor: null },
    { type: null },
    { units: null },
    { day: null },
    { location: null },
    { hasDClearance: true },
    { isCancelled: true },
  ];
  for (const change of changes) {
    const updated = { ...sectionInfo, ...change };
    assert.deepEqual(await collectChanges([updated], async () => [sectionInfo]), [updated]);
  }
});

test("repeated sections retain the last catalog value without an intermediate write", async () => {
  const intermediate = { ...sectionInfo, instructor: "Intermediate Name" };
  assert.deepEqual(await collectChanges([intermediate, sectionInfo], async () => [sectionInfo]), []);
  assert.deepEqual(await collectChanges([sectionInfo, intermediate], async () => [sectionInfo]), [intermediate]);
});

test("empty department responses do not query the database", async () => {
  const writes = await collectChanges([], async () => assert.fail("Unexpected database query"));
  assert.deepEqual(writes, []);
});

test("a failed comparison read fails the refresh instead of treating existing rows as new", async () => {
  await assert.rejects(
    collectChanges([sectionInfo], async () => {
      throw new Error("Database unavailable");
    }),
    /Database unavailable/,
  );
});
