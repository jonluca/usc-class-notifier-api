import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestClient } from "./testing.ts";
import { getD1Executor } from "./executor.ts";

test("real D1 gateway preserves Prisma types, atomic guards, constraints and transaction rejection", async (t) => {
  const fixture = await createD1TestClient();
  const { database: db, executor } = fixture;
  try {
    assert.equal(getD1Executor(db), executor);
    assert.equal(getD1Executor({ classInfo: db.classInfo }), undefined);
    const created = new Date("2026-01-02T03:04:05.678Z");
    t.diagnostic("student.create");
    const student = await db.student.create({
      data: {
        id: "student",
        email: "local@example.invalid",
        verificationKey: created.toISOString(),
        createdAt: created,
        phone: null,
      },
    });
    assert.equal(student.createdAt?.getTime(), created.getTime());
    assert.equal(student.validAccount, false);
    assert.equal(student.phone, null);
    assert.equal(student.verificationKey, created.toISOString());
    assert.deepEqual(
      await executor.query('SELECT typeof("createdAt") AS kind, "createdAt" AS value FROM "Student" WHERE "id" = ?', [
        student.id,
      ]),
      [{ kind: "integer", value: created.getTime() }],
    );
    assert.equal(await db.student.count({ where: { createdAt: { lte: created } } }), 1);
    assert.equal(await db.student.count({ where: { createdAt: { lt: created } } }), 0);
    const classData = {
      department: "CSCI",
      section: "10000",
      courseNumber: "101",
      courseTitle: "Local Course",
      semester: "20263",
    };
    const upsert = () =>
      db.classInfo.upsert({
        where: { section_semester: { section: "10000", semester: "20263" } },
        create: classData,
        update: { courseTitle: "Changed" },
        select: { id: true },
      });
    t.diagnostic("classInfo.upsert");
    const course = await upsert();
    assert.equal((await upsert()).id, course.id);
    t.diagnostic("watchedSection.create");
    const watch = await db.watchedSection.create({
      data: {
        id: "watch",
        studentId: student.id,
        classInfoId: course.id,
        paidId: "ABC123",
        section: "10000",
        semester: "20263",
      },
    });
    assert.equal(watch.isPaid, false);
    t.diagnostic("watch.findMany(include)");
    const included = await db.watchedSection.findMany({ include: { student: true, ClassInfo: true } });
    assert.equal(included[0]?.student.email, student.email);
    assert.equal(included[0]?.ClassInfo?.id, course.id);
    t.diagnostic("watch.updateMany");
    assert.equal((await db.watchedSection.updateMany({ where: { id: watch.id }, data: { notified: true } })).count, 1);
    t.diagnostic("watch.update(include)");
    await assert.rejects(
      db.watchedSection.update({ where: { id: watch.id }, data: { paidNotified: true }, include: { student: true } }),
      /transactions are disabled/,
    );
    assert.equal((await db.watchedSection.findUniqueOrThrow({ where: { id: watch.id } })).paidNotified, false);
    const raw = await fixture.binding
      .prepare('SELECT "email" FROM "Student" WHERE "id" = ?')
      .bind("missing")
      .raw({ columnNames: true });
    assert.deepEqual(raw, [["email"]]);
    await assert.rejects(db.student.create({ data: { email: student.email, verificationKey: "another" } }), {
      code: "P2002",
    });
    await assert.rejects(
      db.$transaction(async () => undefined),
      /transactions are disabled/,
    );
    await assert.rejects(
      executor.batch([
        { sql: 'UPDATE "WatchedSection" SET "notified" = 0 WHERE "id" = ?', params: [watch.id] },
        { sql: 'INSERT INTO "D1Invariant" ("id", "value") VALUES (?, 0)', params: ["fail"] },
      ]),
      /CHECK constraint failed/,
    );
    assert.equal((await db.watchedSection.findUniqueOrThrow({ where: { id: watch.id } })).notified, true);
    await assert.rejects(
      db.watchedSection.create({
        data: { studentId: student.id, paidId: "ABC123", section: "10001", semester: "20271" },
      }),
      { code: "P2002" },
    );
    assert.equal(await db.watchedSection.count(), 1);
    const unauthorized = await fixture.dispatch(
      new Request("https://local.invalid/v1/d1/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, mode: "run", statement: { sql: 'DELETE FROM "Student"' } }),
      }),
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(await db.student.count(), 1);
    const tooManyParameters = await fixture.dispatch(
      new Request("https://local.invalid/v1/d1/query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer local-test-only-token-not-a-production-secret",
        },
        body: JSON.stringify({ version: 1, mode: "all", statement: { sql: "SELECT ?", params: Array(101).fill(1) } }),
      }),
    );
    assert.equal(tooManyParameters.status, 400);
    await assert.rejects(executor.query("SELECT private_sensitive_literal_not_a_column"), /^Error: D1 query failed$/);
  } finally {
    await fixture.dispose();
  }
});
