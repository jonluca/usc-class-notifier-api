import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { TRPCError } from "@trpc/server";
import { PrismaClient } from "@app/prisma";
import { getValidSemesters } from "@/utils/semester";
import { createUserRouter } from "./routers/user";
import { createTRPCRouter } from "./trpc";
import { changeWatchedSection, getSectionChangeEligibility } from "./watchedSectionChange";

const semester = getValidSemesters()[0]!;
const eligible = {
  isPaid: true,
  cancelledAt: null,
  semester,
  smsSentCycle: null,
  lastNotified: null,
  notificationClaimUntil: null,
  NotificationSent: [],
};

test("section changes depend on lifetime SMS delivery, not email delivery or the current notification cycle", () => {
  assert.equal(getSectionChangeEligibility(eligible).canChangeSection, true);
  assert.equal(getSectionChangeEligibility({ ...eligible, lastNotified: new Date() }).canChangeSection, true);
  assert.equal(getSectionChangeEligibility({ ...eligible, smsSentCycle: 0 }).canChangeSection, false);
  assert.equal(getSectionChangeEligibility({ ...eligible, smsSentCycle: 7 }).canChangeSection, false);
  assert.equal(
    getSectionChangeEligibility({ ...eligible, NotificationSent: [{ id: "legacy-email" }] }).canChangeSection,
    false,
  );
  assert.equal(
    getSectionChangeEligibility({ ...eligible, lastNotified: new Date("2026-08-01") }).canChangeSection,
    false,
  );
  assert.equal(
    getSectionChangeEligibility({ ...eligible, notificationClaimUntil: new Date(Date.now() + 60_000) })
      .canChangeSection,
    false,
  );
  assert.equal(
    getSectionChangeEligibility({ ...eligible, notificationClaimUntil: new Date(0) }).canChangeSection,
    true,
  );
});

const testDatabaseUrl = process.env.NOTIFIER_TEST_DATABASE_URL;

test("PostgreSQL paid section changes", { skip: !testDatabaseUrl, timeout: 30_000 }, async (context) => {
  assert.ok(testDatabaseUrl);
  const url = new URL(testDatabaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "tests require a loopback database");
  assert.match(url.pathname, /^\/usc_notification_test(?:_[a-z0-9]+)*$/, "tests require an isolated database name");
  assert.equal(url.search, "");
  const database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: testDatabaseUrl, connectionTimeoutMillis: 2_000, max: 4 }),
  });
  context.after(() => database.$disconnect());

  async function fixture(context: TestContext) {
    const student = await database.student.create({
      data: { email: `${randomUUID()}@section-test.invalid`, verificationKey: randomUUID(), validAccount: true },
    });
    const classes = await Promise.all(
      ["03173", "03172", "03171"].map((section) =>
        database.classInfo.create({
          data: { section, semester, department: "LAW", courseNumber: "LAW-532", courseTitle: "Law" },
        }),
      ),
    );
    const watch = await database.watchedSection.create({
      data: {
        studentId: student.id,
        section: "03173",
        semester,
        paidId: randomUUID(),
        isPaid: true,
        paidNotified: true,
        phoneOverride: "+12025550100",
        classInfoId: classes[0]!.id,
        notified: true,
        notificationCycle: 2,
        emailSentCycle: 2,
        lastNotified: new Date(),
      },
    });
    context.after(async () => {
      await database.notificationSent.deleteMany({ where: { studentId: student.id } });
      await database.watchedSection.deleteMany({ where: { studentId: student.id } });
      await database.student.delete({ where: { id: student.id } });
      await database.classInfo.deleteMany({ where: { id: { in: classes.map((entry) => entry.id) } } });
    });
    return { student, watch, classes, input: { id: watch.id, sectionNumber: "03172", semester } };
  }

  await context.test(
    "moves an email-notified paid alert, preserves payment and leading zeros, and rearms delivery",
    async (context) => {
      const { student, watch, input, classes } = await fixture(context);
      await database.notificationSent.create({ data: { sectionId: watch.id, studentId: student.id } });
      const caller = createTRPCRouter(createUserRouter()).createCaller({ prisma: database, user: student });
      const updated = await caller.changeWatchedClass(input);
      assert.equal(updated.section, "03172");
      assert.equal(updated.ClassInfo?.id, classes[1]!.id);
      assert.equal(updated.paidId, watch.paidId);
      assert.equal(updated.isPaid, true);
      assert.equal(updated.paidNotified, true);
      assert.equal(updated.phoneOverride, watch.phoneOverride);
      assert.equal(updated.notified, false);
      assert.equal(updated.lastNotified, null);
      assert.equal(updated.canChangeSection, true);
      assert.equal("notificationClaimToken" in updated, false);
      assert.equal("smsSentCycle" in updated, false);
      const saved = await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } });
      assert.equal(saved.notificationCycle, 3);
      assert.equal(saved.emailSentCycle, 2);
      assert.equal(saved.smsSentCycle, null);
      assert.equal(await database.notificationSent.count({ where: { sectionId: watch.id } }), 1);
      const watches = await caller.getWatchedClasses();
      assert.equal(watches[0]?.canChangeSection, true);
    },
  );

  await context.test("a prior SMS still blocks a change after rearming", async (context) => {
    const { student, watch, input } = await fixture(context);
    await database.watchedSection.update({ where: { id: watch.id }, data: { smsSentCycle: 0 } });
    const caller = createTRPCRouter(createUserRouter()).createCaller({ prisma: database, user: student });
    await caller.continueReceivingNotificationsForSection({ id: watch.id });
    await assert.rejects(caller.changeWatchedClass(input), /text notification has already been sent/);
    const watches = await caller.getWatchedClasses();
    assert.equal(watches[0]?.canChangeSection, false);
    assert.equal((await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } })).section, watch.section);
  });

  await context.test(
    "rejects unauthorized, foreign, cancelled, unmonitored, missing, and duplicate targets",
    async (context) => {
      const { student, watch, input, classes } = await fixture(context);
      const unauthenticated = createTRPCRouter(createUserRouter()).createCaller({ prisma: database });
      await assert.rejects(
        unauthenticated.changeWatchedClass(input),
        (error) => error instanceof TRPCError && error.code === "UNAUTHORIZED",
      );
      await assert.rejects(
        changeWatchedSection(database, "another-student", input),
        (error) => error instanceof TRPCError && error.code === "NOT_FOUND",
      );
      await assert.rejects(
        changeWatchedSection(database, student.id, { ...input, semester: "20001" }),
        /not currently monitored/,
      );
      await assert.rejects(
        changeWatchedSection(database, student.id, { ...input, sectionNumber: "99999" }),
        /was not found/,
      );
      await database.classInfo.update({ where: { id: classes[1]!.id }, data: { isCancelled: true } });
      await assert.rejects(changeWatchedSection(database, student.id, input), /cancelled/);
      await database.classInfo.update({ where: { id: classes[1]!.id }, data: { isCancelled: false } });
      await database.watchedSection.create({
        data: {
          studentId: student.id,
          semester,
          section: input.sectionNumber,
          paidId: randomUUID(),
          cancelledAt: new Date(),
        },
      });
      await assert.rejects(
        changeWatchedSection(database, student.id, input),
        (error) => error instanceof TRPCError && error.code === "CONFLICT",
      );
      assert.equal(
        (await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } })).section,
        watch.section,
      );
    },
  );

  await context.test(
    "active delivery claims block a transfer; an expired claim is released by the move",
    async (context) => {
      const { student, watch, input } = await fixture(context);
      await database.watchedSection.update({
        where: { id: watch.id },
        data: { notificationClaimToken: "worker", notificationClaimUntil: new Date(Date.now() + 60_000) },
      });
      await assert.rejects(changeWatchedSection(database, student.id, input), /notification is being processed/);
      await database.watchedSection.update({ where: { id: watch.id }, data: { notificationClaimUntil: new Date(0) } });
      await changeWatchedSection(database, student.id, input);
      const moved = await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } });
      assert.equal(moved.notificationClaimToken, null);
      assert.equal(moved.notificationClaimUntil, null);
    },
  );

  await context.test("old ambiguous delivery history is retained and blocks transfer", async (context) => {
    const { student, watch, input } = await fixture(context);
    await database.notificationSent.create({
      data: { sectionId: watch.id, studentId: student.id, createdAt: new Date("2026-08-01") },
    });
    await assert.rejects(changeWatchedSection(database, student.id, input), /older notification history/);
  });
});
