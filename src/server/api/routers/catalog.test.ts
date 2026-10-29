import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@app/prisma";
import { createTRPCRouter } from "@/server/api/trpc";
import { getSectionSearchWhere, sectionSearchSelect } from "@/server/api/classSearch";
import { getValidSemesters } from "@/utils/semester";
import { catalogRouter } from "./catalog";

const semester = getValidSemesters()[0]!;

function createTestClient(context: TestContext) {
  // Unexpected queries can reach only a closed local port, never the live database.
  const client = new PrismaClient({
    adapter: new PrismaPg({ host: "127.0.0.1", port: 1, user: "test", database: "test", connectionTimeoutMillis: 20 }),
  });
  context.after(() => client.$disconnect());
  return client;
}

test("course search accepts USC course spellings and keeps leading-zero section IDs", () => {
  assert.deepEqual(getSectionSearchWhere(semester, "LAW-532"), getSectionSearchWhere(semester, "LAW 532"));
  assert.deepEqual(getSectionSearchWhere(semester, "LAW532"), getSectionSearchWhere(semester, "LAW 532"));
  const sectionSearch = getSectionSearchWhere(semester, "03172D");
  assert.equal(sectionSearch.semester, semester);
  assert.equal(sectionSearch.isCancelled, false);
  assert.deepEqual(sectionSearch, getSectionSearchWhere(semester, "03172"));
  assert.match(JSON.stringify(sectionSearch), /"contains":"03172"/);
  assert.doesNotMatch(JSON.stringify(sectionSearch), /"contains":"3172"/);
});

test("search treats wildcard characters as literal user input", () => {
  const search = JSON.stringify(getSectionSearchWhere(semester, "100% _science"));
  assert.ok(search.includes(JSON.stringify("100\\%").slice(1, -1)));
  assert.ok(search.includes(JSON.stringify("\\_science").slice(1, -1)));
});

test("public catalog search is bounded and returns only section metadata", async (context) => {
  const client = createTestClient(context);
  const classInfo = {
    id: "law-03172",
    department: "LAW",
    section: "03172",
    courseNumber: "LAW-532",
    courseTitle: "Constitutional Law: Rights",
    prefix: "LAW",
    semester,
    instructor: "Example Professor",
    type: "Lecture",
    units: "4",
    day: "MW",
    location: "LAW 101",
    hasDClearance: false,
    isCancelled: false,
  };
  Object.assign(client.classInfo, {
    findMany: async (args: Prisma.ClassInfoFindManyArgs) => {
      assert.equal(args.take, 51);
      assert.deepEqual(args.select, sectionSearchSelect);
      assert.deepEqual(args.where, getSectionSearchWhere(semester, "LAW 532"));
      return Array.from({ length: 51 }, (_, index) => ({ ...classInfo, id: `section-${index}` }));
    },
  });
  const caller = createTRPCRouter(catalogRouter).createCaller({ prisma: client });
  const result = await caller.searchSections({ semester, query: " LAW 532 " });
  assert.equal(result.sections.length, 50);
  assert.equal(result.sections[0]?.section, "03172");
  assert.equal(result.hasMore, true);
});

test("search rejects invalid and unmonitored input before querying the database", async (context) => {
  const client = createTestClient(context);
  Object.assign(client.classInfo, {
    findMany: async () => assert.fail("invalid search must not query the catalog"),
  });
  const caller = createTRPCRouter(catalogRouter).createCaller({ prisma: client });
  for (const input of [
    { semester, query: " " },
    { semester, query: "L" },
    { semester, query: "L".repeat(101) },
    { semester: "2027", query: "LAW" },
    { semester: "20001", query: "LAW" },
  ]) {
    await assert.rejects(caller.searchSections(input), { code: "BAD_REQUEST" });
  }
});
