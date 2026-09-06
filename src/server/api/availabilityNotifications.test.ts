import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@app/prisma";
import { createAvailabilityNotifier, getAvailableSections } from "./availabilityNotifications";
import { createUserRouter } from "./routers/user";
import { createTRPCRouter } from "./trpc";
import { cancelWatchedSection } from "./watchedSectionCancellation";
import type { Course, Section } from "./types";

function offering(sectionId: string, changes: Partial<Section> = {}): Section {
  return {
    sisSectionId: sectionId,
    linkCode: null,
    linkCodeForSort: null,
    rnrSessionId: 1,
    peSectionId: 1,
    courseId: 1,
    hasDClearance: false,
    classType: null,
    name: null,
    notes: null,
    description: null,
    group: null,
    schedule: [],
    totalSeats: 10,
    registeredSeats: 9,
    waitlistedSeats: null,
    rnrMode: "Lecture",
    session: { termCode: "20263", rnrSessionCode: "001", description: null, rnrSessionId: 1 },
    units: ["4"],
    instructors: [],
    syllabus: "",
    isCancelled: false,
    isFull: false,
    rnrModeCode: "LEC",
    term: { value: 20263, year: 2026, term: 3, season: "Fall" },
    termCode: 20263,
    season: "Fall",
    year: 2026,
    ...changes,
  };
}

function course(sections: Section[], prefix = "CSCI"): Course {
  return {
    courseId: 1,
    startTermCode: 20263,
    endTermCode: null,
    classNumber: null,
    sequence: null,
    suffix: null,
    description: null,
    fullCourseName: `${prefix}-104`,
    isCrossListed: false,
    maxUnits: 4,
    courseNotes: null,
    termNotes: null,
    duplicateCredit: null,
    recommendedPrep: null,
    geCode: null,
    scheduledCourseCode: null,
    publishedCourseCode: null,
    matchedCourseCode: null,
    courseUnits: [4],
    sections,
    prerequisiteCourseCodes: null,
    corequisiteCourseCodes: null,
    courseRestrictions: [],
    majorRestrictions: null,
    schoolRestrictions: null,
    concurrentCourses: null,
    remainingSectionSeats: 1,
    sectionSeatCount: 10,
    termCode: 20263,
    prefix,
    name: "Data Structures",
    sortOrder: 1,
  };
}

test("availability excludes cancelled, full, and foreign sections and deduplicates search results", () => {
  const available = getAvailableSections(
    [
      course([
        offering("available"),
        offering("cancelled", { isCancelled: true }),
        offering("full", { registeredSeats: 10 }),
        offering("overbooked", { registeredSeats: 11 }),
      ]),
      course([offering("available")]),
      course([offering("available"), offering("foreign")], "EE"),
      { ...course([]), sections: null },
    ],
    "CSCI",
  );

  assert.deepEqual([...available.keys()], ["available"]);
  assert.equal(available.get("available")?.course.prefix, "CSCI");
});

async function createFixture(database: PrismaClient, context: TestContext) {
  const id = randomUUID();
  const student = await database.student.create({
    data: {
      email: `${id}@notifier-test.invalid`,
      verificationKey: randomUUID(),
      validAccount: true,
      phone: "+12025550100",
    },
  });
  context.after(async () => {
    await database.notificationSent.deleteMany({ where: { studentId: student.id } });
    await database.watchedSection.deleteMany({ where: { studentId: student.id } });
    await database.student.delete({ where: { id: student.id } });
  });
  const watch = await database.watchedSection.create({
    data: { studentId: student.id, section: id, semester: "20263", paidId: id, isPaid: true },
  });
  return { student, watch, courses: [course([offering(watch.section)])] };
}

const testDatabaseUrl = process.env.NOTIFIER_TEST_DATABASE_URL;

test("PostgreSQL notification delivery", { skip: !testDatabaseUrl, timeout: 30_000 }, async (context) => {
  assert.ok(testDatabaseUrl);
  const url = new URL(testDatabaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "tests require a loopback database");
  assert.match(url.pathname, /^\/usc_notification_test(?:_[a-z0-9]+)*$/, "tests require an isolated database name");
  assert.equal(url.search, "", "connection options must not redirect the database host");
  // Never use DATABASE_URL or the production module's default database/senders.
  const database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: testDatabaseUrl, connectionTimeoutMillis: 2_000, max: 4 }),
  });
  context.after(() => database.$disconnect());

  await context.test("cancelled, foreign, full, and cancelled-watch entries never deliver", async (context) => {
    const { watch, courses } = await createFixture(database, context);
    let sends = 0;
    const notify = createAvailabilityNotifier(
      database,
      async () => {
        sends += 1;
      },
      async () => {
        sends += 1;
      },
    );

    await notify("CSCI", watch.semester, [course([offering(watch.section, { isCancelled: true })])]);
    await notify("CSCI", watch.semester, [course([offering(watch.section)], "EE")]);
    await notify("CSCI", watch.semester, [course([offering(watch.section, { registeredSeats: 10 })])]);
    await database.watchedSection.update({ where: { id: watch.id }, data: { cancelledAt: new Date() } });
    await notify("CSCI", watch.semester, courses);
    assert.equal(sends, 0);
  });

  await context.test("concurrent refreshes and duplicate catalog rows deliver each channel once", async (context) => {
    const { watch, courses } = await createFixture(database, context);
    const emailEntered = Promise.withResolvers<void>();
    const releaseEmail = Promise.withResolvers<void>();
    let emails = 0;
    let texts = 0;
    const notify = createAvailabilityNotifier(
      database,
      async () => {
        emails += 1;
        emailEntered.resolve();
        await releaseEmail.promise;
      },
      async () => {
        texts += 1;
      },
    );

    const first = notify("CSCI", watch.semester, [...courses, ...courses]);
    try {
      await emailEntered.promise;
      await notify("CSCI", watch.semester, courses);
      assert.deepEqual({ emails, texts }, { emails: 1, texts: 1 });
    } finally {
      releaseEmail.resolve();
      await first;
    }
    const saved = await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } });
    assert.equal(saved.notified, true);
    assert.equal(saved.emailSentCycle, 0);
    assert.equal(saved.smsSentCycle, 0);
    assert.equal(saved.notificationClaimToken, null);
    assert.equal(saved.notificationClaimUntil, null);
    assert.equal(await database.notificationSent.count({ where: { sectionId: watch.id } }), 1);
  });

  for (const failingChannel of ["email", "sms"]) {
    await context.test(`${failingChannel} failure retries only the failed channel`, async (context) => {
      const { watch, courses } = await createFixture(database, context);
      let fail = true;
      let emails = 0;
      let texts = 0;
      const notify = createAvailabilityNotifier(
        database,
        async () => {
          emails += 1;
          if (fail && failingChannel === "email") {
            throw new Error("Injected email outage");
          }
        },
        async () => {
          texts += 1;
          if (fail && failingChannel === "sms") {
            throw new Error("Injected SMS outage");
          }
        },
      );

      await notify("CSCI", watch.semester, courses);
      const pending = await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } });
      assert.deepEqual({ emails, texts }, { emails: 1, texts: 1 });
      assert.equal(pending.notified, false);
      assert.equal(pending.emailSentCycle, failingChannel === "email" ? null : 0);
      assert.equal(pending.smsSentCycle, failingChannel === "sms" ? null : 0);
      assert.equal(pending.notificationClaimToken, null);
      assert.equal(
        await database.notificationSent.count({ where: { sectionId: watch.id } }),
        failingChannel === "email" ? 0 : 1,
        "only successful emails have durable history",
      );

      fail = false;
      await notify("CSCI", watch.semester, courses);
      await notify("CSCI", watch.semester, courses);
      assert.deepEqual(
        { emails, texts },
        failingChannel === "email" ? { emails: 2, texts: 1 } : { emails: 1, texts: 2 },
      );
      const completed = await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } });
      assert.equal(completed.notified, true);
      assert.equal(completed.emailSentCycle, 0);
      assert.equal(completed.smsSentCycle, 0);
      assert.ok(completed.lastNotified);
      assert.equal(await database.notificationSent.count({ where: { sectionId: watch.id } }), 1);
    });
  }

  await context.test("active claims are skipped and expired claims can be recovered", async (context) => {
    const { watch, courses } = await createFixture(database, context);
    let emails = 0;
    let texts = 0;
    const notify = createAvailabilityNotifier(
      database,
      async () => {
        emails += 1;
      },
      async () => {
        texts += 1;
      },
    );
    await database.watchedSection.update({
      where: { id: watch.id },
      data: { notificationClaimToken: "another-worker", notificationClaimUntil: new Date(Date.now() + 60_000) },
    });
    await notify("CSCI", watch.semester, courses);
    assert.deepEqual({ emails, texts }, { emails: 0, texts: 0 });
    assert.equal(
      (await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } })).notificationClaimToken,
      "another-worker",
    );

    await database.watchedSection.update({
      where: { id: watch.id },
      data: { notificationClaimUntil: new Date(Date.now() - 1_000) },
    });
    await notify("CSCI", watch.semester, courses);
    assert.deepEqual({ emails, texts }, { emails: 1, texts: 1 });
    const recovered = await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } });
    assert.equal(recovered.notified, true);
    assert.equal(recovered.notificationClaimToken, null);
    assert.equal(recovered.notificationClaimUntil, null);
  });

  await context.test("rearming a completed watch starts a new cycle and sends both channels", async (context) => {
    const { student, watch, courses } = await createFixture(database, context);
    let emails = 0;
    let texts = 0;
    const notify = createAvailabilityNotifier(
      database,
      async () => {
        emails += 1;
      },
      async () => {
        texts += 1;
      },
    );
    await notify("CSCI", watch.semester, courses);
    const caller = createTRPCRouter(createUserRouter()).createCaller({ prisma: database, user: student });
    await caller.continueReceivingNotificationsForSection({ id: watch.id });
    const rearmed = await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } });
    assert.equal(rearmed.notificationCycle, 1);
    assert.equal(rearmed.emailSentCycle, 0);
    assert.equal(rearmed.smsSentCycle, 0);
    assert.equal(rearmed.notified, false);

    await notify("CSCI", watch.semester, courses);
    assert.deepEqual({ emails, texts }, { emails: 2, texts: 2 });
    const completed = await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } });
    assert.equal(completed.notified, true);
    assert.equal(completed.emailSentCycle, 1);
    assert.equal(completed.smsSentCycle, 1);
  });

  await context.test(
    "cancelling during delivery preserves cancellation without marking completion",
    async (context) => {
      const { student, watch, courses } = await createFixture(database, context);
      const emailEntered = Promise.withResolvers<void>();
      const releaseEmail = Promise.withResolvers<void>();
      const notify = createAvailabilityNotifier(
        database,
        async () => {
          emailEntered.resolve();
          await releaseEmail.promise;
        },
        async () => {},
      );
      const delivery = notify("CSCI", watch.semester, courses);
      const cancelledAt = new Date();
      try {
        await emailEntered.promise;
        await cancelWatchedSection(database.watchedSection, watch.id, student.id, cancelledAt);
      } finally {
        releaseEmail.resolve();
        await delivery;
      }
      const cancelled = await database.watchedSection.findUniqueOrThrow({ where: { id: watch.id } });
      assert.deepEqual(cancelled.cancelledAt, cancelledAt);
      assert.equal(cancelled.notified, true, "cancellation keeps its stop-notifying sentinel");
      assert.equal(cancelled.lastNotified, null, "delivery must not mark a cancelled watch as completed");
      assert.equal(cancelled.notificationClaimToken, null);
      assert.equal(cancelled.notificationClaimUntil, null);
    },
  );
});
