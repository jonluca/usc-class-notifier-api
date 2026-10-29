import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@app/prisma";
import { getSavedNotificationPhone } from "./notificationPhone";

test("saved phone lookup is scoped to one profile and prefers valid active numbers over cancelled alerts", async (context) => {
  const database = new PrismaClient({
    adapter: new PrismaPg({ host: "127.0.0.1", port: 1, user: "test", database: "test", connectionTimeoutMillis: 20 }),
  });
  context.after(() => database.$disconnect());
  const queries: Prisma.WatchedSectionFindManyArgs[] = [];
  const rows = [
    { phoneOverride: "+12135550103", cancelledAt: new Date() },
    { phoneOverride: "not a phone", cancelledAt: null },
    { phoneOverride: "(213) 555-0102", cancelledAt: null },
    { phoneOverride: "+12135550101", cancelledAt: null },
  ];
  Object.assign(database.watchedSection, {
    findMany: async (args: Prisma.WatchedSectionFindManyArgs) => {
      queries.push(args);
      return rows;
    },
  });
  assert.equal(await getSavedNotificationPhone(database, "student-id"), "+12135550102");
  assert.deepEqual(queries, [
    {
      where: { studentId: "student-id", phoneOverride: { not: null } },
      select: { phoneOverride: true, cancelledAt: true },
      orderBy: [{ createdAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    },
  ]);
  rows.splice(1);
  assert.equal(await getSavedNotificationPhone(database, "student-id"), "+12135550103");
  rows[0]!.phoneOverride = "invalid";
  assert.equal(await getSavedNotificationPhone(database, "student-id"), null);
});
