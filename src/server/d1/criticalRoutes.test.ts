import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestClient } from "./testing";
import { createUserRouter } from "../api/routers/user";
import { createTRPCRouter } from "../api/trpc";
import { createAvailabilityNotifier } from "../api/availabilityNotifications";
import { getValidSemesters } from "@/utils/semester";
import type { Course } from "../api/types";
import { createD1Watch, recordD1EmailDelivery } from "./criticalWrites";

test("real workerd D1 signup, transfers and notifications preserve application invariants", async (context) => {
  const fixture = await createD1TestClient({ installGuards: false });
  context.after(() => fixture.dispose());
  const { database, executor } = fixture;
  const semester = getValidSemesters()[0]!;
  const student = await database.student.create({
    data: {
      email: "synthetic@example.invalid",
      verificationKey: "synthetic-verification",
      validAccount: true,
      phone: "+12025550100",
    },
  });
  const classes = [];
  for (const section of ["03173", "03172", "03171"]) {
    classes.push(
      await database.classInfo.create({
        data: {
          section,
          semester,
          department: "LAW",
          prefix: "LAW",
          courseNumber: "LAW-532",
          courseTitle: "Synthetic Law",
        },
      }),
    );
  }
  const legacy = await database.watchedSection.create({
    data: {
      studentId: student.id,
      section: "03173",
      semester,
      classInfoId: classes[0]!.id,
      paidId: "123",
      cancelledAt: new Date(0),
      notified: true,
    },
  });
  await fixture.installGuards();
  let signupEmails = 0;
  const router = createTRPCRouter(
    createUserRouter(async () => {
      signupEmails += 1;
    }),
  );
  const caller = router.createCaller({ prisma: database, user: student });
  const publicCaller = router.createCaller({ prisma: database });
  const signup = { email: student.email, sectionNumber: "03173", semester, department: "LAW" };

  const concurrent = await Promise.all([caller.addWatchedClass(signup), caller.addWatchedClass(signup)]);
  assert.equal(concurrent[0].paidId, concurrent[1].paidId);
  assert.match(concurrent[0].paidId, /^\d{8}$/);
  assert.equal(signupEmails, 2);
  const readded = await database.watchedSection.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.equal(readded.cancelledAt, null);
  assert.equal(readded.notificationCycle, 2);
  assert.equal(await database.watchedSection.count(), 1);
  const hidden = await publicCaller.addWatchedClass(signup);
  assert.equal(hidden.paidId, "");
  assert.equal(signupEmails, 2);

  const created = await publicCaller.addWatchedClass({
    ...signup,
    email: "new@example.invalid",
    sectionNumber: "03171",
  });
  assert.match(created.paidId, /^\d{8}$/);
  assert.equal(signupEmails, 3);
  assert.equal(await database.student.count(), 2);

  await database.watchedSection.updateMany({ where: { id: legacy.id }, data: { isPaid: true, paidNotified: true } });
  const moved = await caller.changeWatchedClass({ id: legacy.id, sectionNumber: "03172", semester });
  assert.equal(moved.section, "03172");
  assert.equal(moved.paidId, readded.paidId);
  assert.equal(moved.paidNotified, true);
  assert.equal(moved.canChangeSection, true);
  assert.equal("notificationClaimToken" in moved, false);
  const watches = await caller.getWatchedClasses();
  assert.equal(watches.length, 1);
  assert.equal(watches[0]!.ClassInfo?.id, classes[1]!.id);
  await caller.changePhoneNumberForAccount({ phoneNumber: "+12025550100" });

  let emailSends = 0;
  let smsSends = 0;
  // SAFETY: The injected delivery callbacks do not render templates; these are
  // exactly the course/section fields read by the availability notifier itself.
  const course = {
    prefix: "LAW",
    fullCourseName: "LAW-532",
    sections: [
      { sisSectionId: "03172", isCancelled: false, totalSeats: 10, registeredSeats: 9 },
      ...Array.from({ length: 160 }, (_, i) => ({
        sisSectionId: String(60000 + i),
        isCancelled: false,
        totalSeats: 10,
        registeredSeats: 9,
      })),
    ],
  } as Course;
  const notify = createAvailabilityNotifier(
    database,
    async () => {
      emailSends += 1;
    },
    async () => {
      smsSends += 1;
    },
  );
  await Promise.all([notify("LAW", semester, [course]), notify("LAW", semester, [course])]);
  assert.equal(emailSends, 1);
  assert.equal(smsSends, 1);
  const delivered = await database.watchedSection.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.equal(delivered.notified, true);
  assert.equal(delivered.emailSentCycle, delivered.notificationCycle);
  assert.equal(delivered.smsSentCycle, delivered.notificationCycle);
  assert.equal(delivered.notificationClaimToken, null);
  assert.equal(await database.notificationSent.count({ where: { sectionId: legacy.id } }), 1);
  await assert.rejects(
    caller.changeWatchedClass({ id: legacy.id, sectionNumber: "03173", semester }),
    /text notification has already been sent/,
  );

  await assert.rejects(
    recordD1EmailDelivery(executor, {
      id: legacy.id,
      studentId: student.id,
      claimToken: "expired-claim",
      notificationCycle: delivered.notificationCycle,
    }),
    /CHECK constraint failed/,
  );
  assert.equal(await database.notificationSent.count({ where: { sectionId: legacy.id } }), 1);
  assert.deepEqual(await executor.query("SELECT * FROM D1Invariant"), []);

  const collisionRetry = await createD1Watch(
    executor,
    {
      studentId: student.id,
      section: "03173",
      semester,
      classInfoId: classes[0]!.id,
    },
    [readded.paidId, "87654321"],
  );
  assert.equal((await database.watchedSection.findUniqueOrThrow({ where: { id: collisionRetry } })).paidId, "87654321");
  await database.watchedSection.updateMany({
    where: { id: collisionRetry },
    data: { notificationClaimToken: "current" },
  });
  await executor.query(
    "CREATE TRIGGER fail_history BEFORE INSERT ON NotificationSent BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
  await assert.rejects(
    recordD1EmailDelivery(executor, {
      id: collisionRetry,
      studentId: student.id,
      claimToken: "current",
      notificationCycle: 0,
    }),
    /D1 query failed/, // The gateway deliberately redacts arbitrary trigger error text.
  );
  assert.equal(
    (await database.watchedSection.findUniqueOrThrow({ where: { id: collisionRetry } })).emailSentCycle,
    null,
  );
  assert.deepEqual(await executor.query("SELECT * FROM D1Invariant"), []);
});
