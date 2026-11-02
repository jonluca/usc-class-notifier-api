import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createD1TestClient } from "@/server/d1/testing";
import { registerD1Executor, type D1Statement } from "@/server/d1/executor";
import { saveCatalogSections } from "./catalogRefreshWrites";
import type { ClassInfoRefreshData } from "./classInfoRefresh";

const sectionInfo: ClassInfoRefreshData = {
  section: "03001",
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

test("D1 catalog upserts preserve identity, skip unchanged rows and reject stale replay", async () => {
  const fixture = await createD1TestClient();
  const { database, executor } = fixture;
  const writes: D1Statement[] = [];
  registerD1Executor(database, {
    query: async (sql, params) => {
      writes.push({ sql, params });
      return executor.query(sql, params);
    },
    batch: (statements) => executor.batch(statements),
  });
  try {
    const first = 1_790_000_000_000;
    assert.equal(await saveCatalogSections(database, sectionInfo.semester, [sectionInfo], first), 1);
    const original = await database.classInfo.findFirstOrThrow();
    const student = await database.student.create({
      data: { email: "catalog-test@example.invalid", verificationKey: "catalog-test" },
    });
    const watch = await database.watchedSection.create({
      data: {
        studentId: student.id,
        section: sectionInfo.section,
        semester: sectionInfo.semester,
        paidId: "11000000",
        classInfoId: original.id,
      },
    });
    writes.length = 0;
    assert.equal(await saveCatalogSections(database, sectionInfo.semester, [sectionInfo], first + 100), 0);
    assert.deepEqual(writes, [], "unchanged data does not issue native writes");
    const changed = { ...sectionInfo, instructor: null, courseTitle: "Newer Title", hasDClearance: true };
    assert.equal(await saveCatalogSections(database, sectionInfo.semester, [changed], first + 200), 1);
    const updated = await database.classInfo.findFirstOrThrow();
    assert.equal(updated.id, original.id);
    assert.equal(updated.createdAt?.getTime(), first);
    assert.equal(updated.updatedAt?.getTime(), first + 200);
    assert.equal(updated.instructor, null);
    assert.equal(updated.hasDClearance, true);
    assert.equal(
      (await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } })).classInfoId,
      original.id,
    );
    assert.equal(await saveCatalogSections(database, sectionInfo.semester, [sectionInfo], first + 100), 0);
    const afterReplay = await database.classInfo.findFirstOrThrow();
    assert.equal(afterReplay.courseTitle, "Newer Title");
    assert.equal(afterReplay.updatedAt?.getTime(), first + 200);
    assert.equal(await saveCatalogSections(database, sectionInfo.semester, [changed], first + 200), 0);
  } finally {
    await fixture.dispose();
  }
});

test("D1 catalog writes use one JSON parameter and at most 50 rows per statement", async () => {
  const fixture = await createD1TestClient();
  const { database, executor } = fixture;
  const sizes: number[] = [];
  registerD1Executor(database, {
    query: async (sql, params) => {
      assert.equal(params?.length, 1);
      const json = z.string().parse(params?.[0]);
      sizes.push(JSON.parse(json).length);
      assert.ok(new TextEncoder().encode(JSON.stringify({ sql, params })).length < 2_000_000);
      return executor.query(sql, params);
    },
    batch: (statements) => executor.batch(statements),
  });
  try {
    const rows = Array.from({ length: 121 }, (_, i) => ({ ...sectionInfo, section: String(30_000 + i) }));
    assert.equal(await saveCatalogSections(database, sectionInfo.semester, rows, 1_790_000_000_000), 121);
    assert.deepEqual(sizes, [50, 50, 21]);
    assert.equal(await database.classInfo.count(), 121);
    await assert.rejects(saveCatalogSections(database, sectionInfo.semester, rows, NaN), /capture time/);
    await assert.rejects(saveCatalogSections(database, "20271", rows), /semester mismatch/);
  } finally {
    await fixture.dispose();
  }
});
