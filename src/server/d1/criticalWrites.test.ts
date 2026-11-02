import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { z } from "zod/v4";
import type { D1Executor, D1Value } from "./executor";
import {
  createD1Watch,
  readdD1Watch,
  rotateD1PaidReference,
  moveD1Watch,
  recordD1EmailDelivery,
} from "./criticalWrites";

const sqliteRowsSchema = z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])));

function fixture(context: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  context.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec(readFileSync(new URL("../../../prisma/d1/migrations/0001_schema.sql", import.meta.url), "utf8"));
  sqlite.exec(`INSERT INTO Student(id,email,verificationKey,validAccount) VALUES ('student','local@test.invalid','key',1);
    INSERT INTO ClassInfo(id,department,section,courseNumber,courseTitle,semester)
    VALUES ('class1','LAW','03173','LAW-532','Law','20271'),('class2','LAW','03172','LAW-532','Law','20271'),
           ('class3','LAW','03173','LAW-532','Law','20273');`);
  const executor: D1Executor = {
    async query<T>(sql: string, params: D1Value[] = []) {
      // SAFETY: This local executor mirrors the typed SQL executor contract;
      // callers supply T for the explicit SELECT/RETURNING columns they own.
      return sqlite.prepare(sql).all(...params) as T[];
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(({ sql, params = [] }) => {
          const rows = sqliteRowsSchema.parse(sqlite.prepare(sql).all(...params));
          const changes = Number(sqlite.prepare("SELECT changes() AS n").get()!.n);
          return { results: rows, meta: { changes } };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  function installGuards() {
    sqlite.exec(
      readFileSync(new URL("../../../prisma/d1/migrations/0002_payment_reference_guards.sql", import.meta.url), "utf8"),
    );
  }
  return { sqlite, executor, installGuards };
}

const identity = { studentId: "student", section: "03173", semester: "20271", classInfoId: "class1" };
const legacyCutoff = new Date("2026-09-06T02:06:41.804Z").getTime();

test("real SQLite reference triggers preserve imported duplicates and prevent cross-semester reuse", async (context) => {
  const { sqlite, executor, installGuards } = fixture(context);
  sqlite.exec(`INSERT INTO WatchedSection(id,section,semester,studentId,paidId)
    VALUES ('old1','90001','20001','student','12345678'),('old2','90001','20003','student','12345678')`);
  installGuards();
  const [first, second] = await Promise.all([
    createD1Watch(executor, identity, ["12345678", "23456789", "34567890"]),
    createD1Watch(executor, { ...identity, semester: "20273", classInfoId: "class3" }, ["23456789", "34567890"]),
  ]);
  const rows = sqlite.prepare("SELECT paidId FROM WatchedSection WHERE id IN (?,?)").all(first, second);
  assert.equal(new Set(rows.map((row) => row.paidId)).size, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM PaymentReference").get()!.n, 3);
  sqlite.exec("DELETE FROM WatchedSection WHERE id IN ('old1','old2')");
  await assert.rejects(
    createD1Watch(executor, { ...identity, section: "03172", classInfoId: "class2" }, ["12345678"]),
    /globally unique/,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM WatchedSection WHERE section='03172'").get()!.n, 0);
});

test("concurrent re-add and repair keep one final reference and preserve paid/channel history", async (context) => {
  const { sqlite, executor, installGuards } = fixture(context);
  sqlite.exec(`INSERT INTO WatchedSection(id,section,semester,studentId,paidId,cancelledAt,notified,emailSentCycle,smsSentCycle)
    VALUES ('legacy','03173','20271','student','123',1,1,4,4)`);
  installGuards();
  await Promise.all([
    readdD1Watch(executor, { ...identity, id: "legacy" }, ["23456789"]),
    readdD1Watch(executor, { ...identity, id: "legacy" }, ["34567890"]),
    rotateD1PaidReference(executor, { id: "legacy", paidId: "123" }, ["45678901"]),
  ]);
  const row = sqlite.prepare("SELECT * FROM WatchedSection WHERE id='legacy'").get()!;
  assert.equal(row.paidId, "23456789");
  assert.equal(row.cancelledAt, null);
  assert.equal(row.notificationCycle, 2);
  assert.equal(row.emailSentCycle, 4);
  assert.equal(row.smsSentCycle, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM PaymentReference").get()!.n, 2);
  sqlite.exec("UPDATE WatchedSection SET isPaid=1 WHERE id='legacy'");
  assert.equal(await rotateD1PaidReference(executor, { id: "legacy", paidId: "23456789" }), 0);
});

test("transfer and notification claim race is resolved by the guarded SQL mutation", async (context) => {
  const { sqlite, executor, installGuards } = fixture(context);
  installGuards();
  const id = await createD1Watch(executor, identity, ["23456789"]);
  sqlite
    .prepare(
      "UPDATE WatchedSection SET isPaid=1,paidNotified=1,phoneOverride='+12025550100',emailSentCycle=0 WHERE id=?",
    )
    .run(id);
  const move = {
    ...identity,
    id,
    section: "03172",
    classInfoId: "class2",
    previousSection: "03173",
    notificationCycle: 0,
    legacyCutoff,
  };
  sqlite
    .prepare("UPDATE WatchedSection SET notificationClaimToken='active',notificationClaimUntil=? WHERE id=?")
    .run(Date.now() + 60_000, id);
  assert.equal(await moveD1Watch(executor, move), false);
  sqlite.prepare("UPDATE WatchedSection SET notificationClaimUntil=0 WHERE id=?").run(id);
  assert.equal(await moveD1Watch(executor, move), true);
  // An already-selected worker cannot claim the old section after the move.
  const oldClaim = sqlite
    .prepare("UPDATE WatchedSection SET notificationClaimToken='late' WHERE id=? AND section='03173'")
    .run(id);
  assert.equal(oldClaim.changes, 0);
  const moved = sqlite.prepare("SELECT * FROM WatchedSection WHERE id=?").get(id)!;
  assert.equal(moved.paidId, "23456789");
  assert.equal(moved.paidNotified, 1);
  assert.equal(moved.phoneOverride, "+12025550100");
  assert.equal(moved.emailSentCycle, 0);
  assert.equal(moved.notificationCycle, 1);
  assert.equal(moved.notificationClaimToken, null);
  assert.equal(await moveD1Watch(executor, move), false, "a stale cycle cannot move the alert again");
});

test("transfers reject lifetime SMS, legacy history, cancelled target and duplicate watch without partial writes", async (context) => {
  const { sqlite, executor, installGuards } = fixture(context);
  installGuards();
  const id = await createD1Watch(executor, identity, ["23456789"]);
  sqlite.prepare("UPDATE WatchedSection SET isPaid=1,smsSentCycle=0 WHERE id=?").run(id);
  const move = {
    ...identity,
    id,
    section: "03172",
    classInfoId: "class2",
    previousSection: "03173",
    notificationCycle: 0,
    legacyCutoff,
  };
  assert.equal(await moveD1Watch(executor, move), false);
  sqlite.prepare("UPDATE WatchedSection SET smsSentCycle=NULL WHERE id=?").run(id);
  sqlite
    .prepare("INSERT INTO NotificationSent(id,sectionId,studentId,createdAt) VALUES ('history',?,'student',NULL)")
    .run(id);
  assert.equal(await moveD1Watch(executor, move), false);
  sqlite.exec("DELETE FROM NotificationSent WHERE id='history'; UPDATE ClassInfo SET isCancelled=1 WHERE id='class2'");
  assert.equal(await moveD1Watch(executor, move), false);
  sqlite.exec("UPDATE ClassInfo SET isCancelled=0 WHERE id='class2'");
  await createD1Watch(executor, { ...identity, section: "03172", classInfoId: "class2" }, ["34567890"]);
  await assert.rejects(moveD1Watch(executor, move), /UNIQUE constraint/);
  assert.equal(sqlite.prepare("SELECT section FROM WatchedSection WHERE id=?").get(id)!.section, "03173");
});

test("delivery batch rolls back stale claims and later failures, and commits history with the matching cycle", async (context) => {
  const { sqlite, executor, installGuards } = fixture(context);
  installGuards();
  const id = await createD1Watch(executor, identity, ["23456789"]);
  sqlite
    .prepare("UPDATE WatchedSection SET notificationClaimToken='current',notificationCycle=2,smsSentCycle=1 WHERE id=?")
    .run(id);
  const delivery = { id, studentId: "student", claimToken: "current", notificationCycle: 2 };
  await assert.rejects(recordD1EmailDelivery(executor, { ...delivery, claimToken: "stale" }), /CHECK constraint/);
  await assert.rejects(recordD1EmailDelivery(executor, { ...delivery, notificationCycle: 1 }), /CHECK constraint/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM NotificationSent").get()!.n, 0);
  sqlite.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON NotificationSent BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
  await assert.rejects(recordD1EmailDelivery(executor, delivery), /history unavailable/);
  assert.equal(sqlite.prepare("SELECT emailSentCycle FROM WatchedSection WHERE id=?").get(id)!.emailSentCycle, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM D1Invariant").get()!.n, 0);
  sqlite.exec("DROP TRIGGER fail_history");
  await recordD1EmailDelivery(executor, delivery);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM NotificationSent").get()!.n, 1);
  assert.deepEqual(
    { ...sqlite.prepare("SELECT emailSentCycle,smsSentCycle FROM WatchedSection WHERE id=?").get(id) },
    { emailSentCycle: 2, smsSentCycle: 1 },
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM D1Invariant").get()!.n, 0);
});
