import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestClient } from "@/server/d1/testing";
import { getValidSemesters } from "@/utils/semester";
import { searchSections } from "./classSearch";
import { classInfoRefreshSelect, getChangedClassInfo } from "./classInfoRefresh";
import { getD1PaymentPreflight, markD1PaymentPaid } from "../../../jobs/venmoGmail/d1Payments";

test("real D1 supports catalog comparison/search and receipt timestamp guards through the application client", async () => {
  const fixture = await createD1TestClient();
  const { database, executor } = fixture;
  try {
    const semester = getValidSemesters()[0]!;
    const student = await database.student.create({
      data: { email: "d1-queries@example.invalid", verificationKey: "d1-queries" },
    });
    const catalog = await database.classInfo.create({
      data: { department: "LAW", section: "03172", courseNumber: "LAW-532", courseTitle: "Économie 100%", semester },
    });
    for (const query of ["LAW532", "03172D", "économie", "100%", "économie 100%"]) {
      const result = await searchSections(database, semester, query);
      assert.deepEqual(
        result.sections.map((row) => row.id),
        [catalog.id],
      );
      assert.equal(result.hasMore, false);
    }
    const existing = await database.classInfo.findMany({ select: classInfoRefreshSelect });
    const writes = [];
    for await (const row of getChangedClassInfo(
      existing,
      (sections) =>
        database.classInfo.findMany({
          where: { semester, section: { in: sections } },
          select: classInfoRefreshSelect,
        }),
      80,
    )) {
      writes.push(row);
    }
    assert.deepEqual(writes, []);
    const createdAt = new Date("2026-10-01T12:34:56.789Z");
    const watch = await database.watchedSection.create({
      data: {
        studentId: student.id,
        classInfoId: catalog.id,
        section: "03172",
        semester,
        paidId: "87246193",
        createdAt,
      },
    });
    const candidate = { rowId: watch.id, paidId: watch.paidId, semester, receiptCutoff: createdAt };
    assert.equal(
      await markD1PaymentPaid(executor, { ...candidate, receiptCutoff: new Date(createdAt.getTime() - 1) }),
      0,
    );
    assert.equal(await markD1PaymentPaid(executor, candidate, true), 1);
    assert.equal(await markD1PaymentPaid(executor, candidate, true), 0);
    const updated = await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } });
    assert.equal(updated.isPaid, true);
    assert.equal(updated.createdAt?.getTime(), createdAt.getTime());
    assert.equal((await getD1PaymentPreflight(executor)).totalRowCount, 1);
  } finally {
    await fixture.dispose();
  }
});
