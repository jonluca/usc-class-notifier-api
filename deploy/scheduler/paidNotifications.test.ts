import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createD1TestClient } from "../../src/server/d1/testing";
import type { D1Statement } from "../../src/server/d1/executor";
import { runPaidNotificationPage, type PaidNotificationDependencies } from "./paidNotifications";

async function fixture(context: TestContext, count = 23) {
  const local = await createD1TestClient();
  context.after(() => local.dispose());
  const statements: D1Statement[] = [
    {
      sql: "INSERT INTO Student(id,email,verificationKey) VALUES (?,?,?)",
      params: ["student", "local@test.invalid", "synthetic-key"],
    },
    {
      sql: "INSERT INTO ClassInfo(id,department,section,courseNumber,courseTitle,semester) VALUES (?,?,?,?,?,?)",
      params: ["class", "TEST", "s000", "TEST-100", "Synthetic class", "20271"],
    },
  ];
  for (let index = 0; index < count; index++) {
    const suffix = String(index).padStart(3, "0");
    statements.push({
      sql: "INSERT INTO WatchedSection(id,section,semester,paidId,studentId,isPaid,classInfoId) VALUES (?,?,?,?,?,?,?)",
      params: [
        `watch-${suffix}`,
        `s${suffix}`,
        "20271",
        String(10_000_000 + index),
        "student",
        1,
        index === 0 ? "class" : null,
      ],
    });
  }
  statements.push(
    {
      sql: "INSERT INTO WatchedSection(id,section,semester,paidId,studentId,isPaid) VALUES (?,?,?,?,?,?)",
      params: ["ineligible-unpaid", "u", "20271", "20000001", "student", 0],
    },
    {
      sql: "INSERT INTO WatchedSection(id,section,semester,paidId,studentId,isPaid,paidNotified) VALUES (?,?,?,?,?,?,?)",
      params: ["ineligible-notified", "n", "20271", "20000002", "student", 1, 1],
    },
    {
      sql: "INSERT INTO WatchedSection(id,section,semester,paidId,studentId,isPaid,cancelledAt) VALUES (?,?,?,?,?,?,?)",
      params: ["ineligible-cancelled", "c", "20271", "20000003", "student", 1, 1],
    },
  );
  await local.executor.batch(statements);
  return local;
}

test("real D1 pages default to ten ordered eligible rows and preserve relation data", async (context) => {
  const local = await fixture(context);
  const delivered: string[] = [];
  const dependencies: PaidNotificationDependencies = {
    database: local.database,
    send: async (input) => {
      delivered.push(input.sectionEntry.section);
      assert.equal(input.email, "local@test.invalid");
      assert.equal(input.verificationKey, "synthetic-key");
      if (input.sectionEntry.section === "s000") {
        assert.equal(input.classInfo?.courseNumber, "TEST-100");
      }
    },
  };
  const first = await runPaidNotificationPage({}, dependencies);
  assert.deepEqual(first, { summary: { selected: 10, sent: 10, failed: 0 }, nextCursor: "watch-009" });
  const second = await runPaidNotificationPage({ afterId: first.nextCursor }, dependencies);
  assert.deepEqual(second, { summary: { selected: 10, sent: 10, failed: 0 }, nextCursor: "watch-019" });
  const last = await runPaidNotificationPage({ afterId: second.nextCursor }, dependencies);
  assert.deepEqual(last, { summary: { selected: 3, sent: 3, failed: 0 } });
  assert.equal(new Set(delivered).size, 23);
  assert.deepEqual(
    delivered,
    Array.from({ length: 23 }, (_item, index) => `s${String(index).padStart(3, "0")}`),
  );
  assert.deepEqual(await runPaidNotificationPage({}, dependencies), { summary: { selected: 0, sent: 0, failed: 0 } });
});

test("failed sends remain eligible and are retried by the next cursorless cron, while continuation advances", async (context) => {
  const local = await fixture(context, 4);
  const first = await runPaidNotificationPage(
    { limit: 3 },
    {
      database: local.database,
      send: async (input) => {
        if (input.sectionEntry.section === "s001") {
          throw new Error("Synthetic provider failure");
        }
      },
    },
  );
  assert.deepEqual(first, { summary: { selected: 3, sent: 2, failed: 1 }, nextCursor: "watch-002" });
  assert.equal((await local.database.watchedSection.findUnique({ where: { id: "watch-001" } }))?.paidNotified, false);
  const continuation = await runPaidNotificationPage(
    { afterId: first.nextCursor },
    { database: local.database, send: async () => {} },
  );
  assert.deepEqual(continuation, { summary: { selected: 1, sent: 1, failed: 0 } });
  const retried: string[] = [];
  const nextCron = await runPaidNotificationPage(
    {},
    {
      database: local.database,
      send: async (input) => {
        retried.push(input.sectionEntry.section);
      },
    },
  );
  assert.deepEqual(nextCron, { summary: { selected: 1, sent: 1, failed: 0 } });
  assert.deepEqual(retried, ["s001"]);
});

test("eligibility changes during a successful provider send prevent paidNotified from being recorded", async (context) => {
  const local = await fixture(context, 1);
  let providerAccepted = 0;
  const result = await runPaidNotificationPage(
    {},
    {
      database: local.database,
      send: async () => {
        providerAccepted++;
        await local.database.watchedSection.updateMany({
          where: { id: "watch-000" },
          data: { cancelledAt: new Date() },
        });
      },
    },
  );
  assert.equal(providerAccepted, 1);
  assert.deepEqual(result, { summary: { selected: 1, sent: 0, failed: 1 } });
  assert.equal((await local.database.watchedSection.findUnique({ where: { id: "watch-000" } }))?.paidNotified, false);
});

test("twenty is the maximum page size and invalid bounds cause no sends", async (context) => {
  const local = await fixture(context);
  let sends = 0;
  const dependencies = {
    database: local.database,
    send: async () => {
      sends++;
    },
  };
  for (const limit of [0, -1, 21, 1.5, Number.NaN]) {
    await assert.rejects(runPaidNotificationPage({ limit }, dependencies));
  }
  await assert.rejects(runPaidNotificationPage({ afterId: "" }, dependencies));
  assert.equal(sends, 0);
  const result = await runPaidNotificationPage({ limit: 20 }, dependencies);
  assert.deepEqual(result, { summary: { selected: 20, sent: 20, failed: 0 }, nextCursor: "watch-019" });
  assert.equal(sends, 20);
});
