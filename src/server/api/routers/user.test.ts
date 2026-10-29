import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { TRPCError } from "@trpc/server";
import { PrismaClient, type ClassInfo, type Prisma, type Student, type WatchedSection } from "@app/prisma";
import { createUserRouter } from "./user";
import { createTRPCRouter } from "../trpc";
import { getValidSemesters } from "@/utils/semester";
import type { NowWatchingEmailProps } from "@/emails/NowWatchingEmail";

const semester = getValidSemesters()[0]!;
const student: Student = {
  id: "student-id",
  createdAt: null,
  updatedAt: null,
  email: "student@example.com",
  verificationKey: "verification-key",
  phone: null,
  validAccount: true,
  uscID: null,
};
const classInfo: ClassInfo = {
  id: "class-info-id",
  createdAt: null,
  updatedAt: null,
  department: "CSCI",
  section: "12345",
  courseNumber: "CSCI-104",
  courseTitle: "Data Structures",
  semester,
  instructor: null,
  type: null,
  prefix: "CSCI",
  units: null,
  day: null,
  session: null,
  location: null,
  isDistanceLearning: false,
  hasDClearance: false,
  isCancelled: false,
};
const section: WatchedSection & { ClassInfo: ClassInfo } = {
  id: "watched-section-id",
  createdAt: null,
  updatedAt: null,
  section: classInfo.section,
  semester,
  lastNotified: null,
  notificationCycle: 0,
  emailSentCycle: null,
  smsSentCycle: null,
  notificationClaimToken: null,
  notificationClaimUntil: null,
  notified: false,
  cancelledAt: null,
  paidId: "12345678",
  isPaid: false,
  paidNotified: false,
  phoneOverride: null,
  studentId: student.id,
  classInfoId: classInfo.id,
  ClassInfo: classInfo,
};
const signup = { sectionNumber: section.section, semester, email: student.email, department: "CSCI" };

function createTestClient(context: TestContext) {
  // An unexpected query can only target a closed local port, never the configured database.
  const client = new PrismaClient({
    adapter: new PrismaPg({
      host: "127.0.0.1",
      port: 1,
      user: "test",
      database: "test",
      connectionTimeoutMillis: 20,
    }),
  });
  context.after(() => client.$disconnect());
  return client;
}

test("verifies an account in one database statement and preserves the missing-account response", async (context) => {
  const client = createTestClient(context);
  const updates: Prisma.StudentUpdateManyArgs[] = [];
  Object.assign(client.student, {
    updateMany: async (args: Prisma.StudentUpdateManyArgs) => {
      updates.push(args);
      return { count: updates.length === 1 ? 1 : 0 };
    },
  });
  const caller = createTRPCRouter(createUserRouter()).createCaller({ prisma: client });

  assert.deepEqual(await caller.verifyByKey({ key: student.verificationKey }), {
    success: true,
    message: "Verification successful",
  });
  assert.deepEqual(await caller.verifyByKey({ key: "missing" }), { success: false, message: "User not found" });
  assert.deepEqual(updates, [
    { where: { verificationKey: student.verificationKey }, data: { validAccount: true } },
    { where: { verificationKey: "missing" }, data: { validAccount: true } },
  ]);
});

test("new watch signup only writes its own linked section and reuses its metadata for email", async (context) => {
  const client = createTestClient(context);
  const queries: string[] = [];
  const emails: NowWatchingEmailProps[] = [];
  const studentRead = Promise.withResolvers<void>();
  Object.assign(client.classInfo, {
    findUnique: async () => {
      queries.push("classInfo");
      // The independent student lookup must start while class metadata is still loading.
      await studentRead.promise;
      return { id: classInfo.id };
    },
  });
  Object.assign(client.student, {
    findUnique: async () => {
      queries.push("student");
      studentRead.resolve();
      return student;
    },
  });
  Object.assign(client.watchedSection, {
    findUnique: async (args: Prisma.WatchedSectionFindUniqueArgs) => {
      queries.push("existing-watch");
      assert.deepEqual(args.where, {
        semester_studentId_section: { semester, studentId: student.id, section: section.section },
      });
      return null;
    },
  });
  Object.assign(client, {
    $transaction: async (action: (transaction: Prisma.TransactionClient) => Promise<WatchedSection>) => action(client),
  });
  Object.assign(client, {
    $executeRaw: async (query: TemplateStringsArray) => {
      queries.push("allocation-lock");
      assert.match(query.join("?"), /^SELECT pg_advisory_xact_lock\(/);
      return 1;
    },
  });
  Object.assign(client.watchedSection, {
    findMany: async (args: Prisma.WatchedSectionFindManyArgs) => {
      queries.push(args.select?.phoneOverride ? "saved-phone-check" : "paid-reference-check");
      return [];
    },
  });
  Object.assign(client.watchedSection, {
    create: async (args: Prisma.WatchedSectionCreateArgs) => {
      queries.push("create-watch");
      assert.equal(args.data.classInfoId, classInfo.id);
      assert.equal(args.data.studentId, student.id);
      return section;
    },
  });
  const caller = createTRPCRouter(
    createUserRouter(async (email) => {
      emails.push(email);
    }),
  ).createCaller({ prisma: client });

  const result = await caller.addWatchedClass(signup);

  assert.equal(result.alreadyWatching, false);
  assert.deepEqual(queries, [
    "classInfo",
    "student",
    "existing-watch",
    "saved-phone-check",
    "allocation-lock",
    "paid-reference-check",
    "create-watch",
  ]);
  assert.equal(emails.length, 1);
  assert.equal(emails[0]?.classInfo, classInfo);
});

test("re-adding a legacy watch repairs only that section's class relation", async (context) => {
  const client = createTestClient(context);
  const updates: Prisma.WatchedSectionUpdateArgs[] = [];
  const emails: NowWatchingEmailProps[] = [];
  Object.assign(client.classInfo, { findUnique: async () => ({ id: classInfo.id }) });
  Object.assign(client.student, { findUnique: async () => student });
  Object.assign(client.watchedSection, {
    findUnique: async () => ({
      ...section,
      classInfoId: null,
      cancelledAt: new Date(0),
    }),
  });
  Object.assign(client, {
    $transaction: async (action: (transaction: Prisma.TransactionClient) => Promise<WatchedSection>) => action(client),
  });
  Object.assign(client, {
    $executeRaw: async (query: TemplateStringsArray) => {
      assert.match(query.join("?"), /^SELECT pg_advisory_xact_lock\(/);
      return 1;
    },
  });
  Object.assign(client.watchedSection, {
    findMany: async () => [],
    update: async (args: Prisma.WatchedSectionUpdateArgs) => {
      updates.push(args);
      return section;
    },
  });
  const caller = createTRPCRouter(
    createUserRouter(async (email) => {
      emails.push(email);
    }),
  ).createCaller({ prisma: client, user: student });

  const result = await caller.addWatchedClass(signup);

  assert.equal(result.alreadyWatching, false);
  assert.equal(emails[0]?.classInfo, classInfo);
  assert.deepEqual(updates, [
    {
      where: { id: section.id, section: section.section, semester, studentId: student.id },
      data: {
        cancelledAt: null,
        paidId: section.paidId,
        classInfoId: classInfo.id,
        notified: false,
        notificationCycle: { increment: 1 },
      },
      include: { ClassInfo: true },
    },
  ]);
});

test("a concurrent section move prevents re-add from attaching the former section's metadata", async (context) => {
  const client = createTestClient(context);
  let reads = 0;
  Object.assign(client.classInfo, { findUnique: async () => ({ id: classInfo.id }) });
  Object.assign(client.student, { findUnique: async () => student });
  Object.assign(client.watchedSection, {
    findUnique: async () => {
      reads += 1;
      return reads === 1 ? section : { ...section, section: "54321" };
    },
    update: async () => assert.fail("a moved watch must not be modified by a stale re-add"),
  });
  Object.assign(client, {
    $transaction: async (action: (transaction: Prisma.TransactionClient) => Promise<WatchedSection>) => action(client),
    $executeRaw: async () => 1,
  });
  const caller = createTRPCRouter(createUserRouter(async () => assert.fail("no email should be sent"))).createCaller({
    prisma: client,
    user: student,
  });
  await assert.rejects(caller.addWatchedClass(signup), /alert changed while you were signing up/);
});

function createSignupFixture(
  context: TestContext,
  {
    newProfile = false,
    accountPhone = null,
    savedPhone = "+12135550100",
  }: {
    newProfile?: boolean;
    accountPhone?: string | null;
    savedPhone?: string | null;
  } = {},
) {
  const client = createTestClient(context);
  const profile = { ...student, phone: accountPhone, validAccount: !newProfile };
  const creates: Prisma.WatchedSectionCreateArgs[] = [];
  const studentCreates: Prisma.StudentCreateArgs[] = [];
  const emails: NowWatchingEmailProps[] = [];
  Object.assign(client.classInfo, { findUnique: async () => ({ id: classInfo.id }) });
  Object.assign(client.student, {
    findUnique: async () => (newProfile ? null : profile),
    create: async (args: Prisma.StudentCreateArgs) => {
      studentCreates.push(args);
      return profile;
    },
  });
  Object.assign(client.watchedSection, {
    findUnique: async () => null,
    findMany: async (args: Prisma.WatchedSectionFindManyArgs) => {
      if (args.select?.phoneOverride) {
        assert.equal(args.where?.studentId, profile.id, "fallback lookup must remain on the supplied profile");
        return savedPhone ? [{ phoneOverride: savedPhone, cancelledAt: null }] : [];
      }
      assert.ok(args.select?.paidId);
      return [];
    },
    create: async (args: Prisma.WatchedSectionCreateArgs) => {
      creates.push(args);
      return { ...section, phoneOverride: args.data.phoneOverride ?? null };
    },
  });
  Object.assign(client, {
    $transaction: async (action: (transaction: Prisma.TransactionClient) => Promise<WatchedSection>) => action(client),
    $executeRaw: async () => 1,
  });
  const router = createTRPCRouter(
    createUserRouter(async (email) => {
      emails.push(email);
    }),
  );
  return {
    client,
    profile,
    creates,
    studentCreates,
    emails,
    caller: (user?: Student) => router.createCaller({ prisma: client, user }),
  };
}

test("public signup inherits a saved phone for payment eligibility without persisting or revealing it", async (context) => {
  const fixture = createSignupFixture(context);
  const result = await fixture.caller().addWatchedClass(signup);
  assert.equal(result.showVenmoInfo, true);
  assert.equal(fixture.emails[0]?.showVenmoInfo, true);
  assert.equal(fixture.creates[0]?.data.phoneOverride, undefined);
  assert.equal("phoneOverride" in result && result.phoneOverride, null);
  assert.equal("notificationPhone" in result, false);
  assert.equal(JSON.stringify(result).includes("2135550100"), false);
  assert.equal(JSON.stringify(result).includes(student.verificationKey), false);
});

test("anonymous signup can reuse the saved default but cannot seed a new profile fallback", async (context) => {
  const fixture = createSignupFixture(context);
  const result = await fixture.caller().addWatchedClass({ ...signup, phone: "(213) 555-0100" });
  assert.equal(result.showVenmoInfo, true);
  assert.equal(fixture.creates[0]?.data.phoneOverride, undefined);
  assert.equal("phoneOverride" in result && result.phoneOverride, null);
  for (const user of [undefined, { ...student, id: "another-student" }]) {
    await assert.rejects(
      fixture.caller(user).addWatchedClass({ ...signup, phone: "+12135550199" }),
      (error) => error instanceof TRPCError && error.code === "FORBIDDEN",
    );
  }
  assert.equal(fixture.creates.length, 1, "rejected signups must not create watches");
  assert.equal(fixture.emails.length, 1, "rejected signups must not send email");
});

test("authenticated signup retains a supplied section override over account and sibling numbers", async (context) => {
  const fixture = createSignupFixture(context, { accountPhone: "+12135550101" });
  const result = await fixture.caller(fixture.profile).addWatchedClass({ ...signup, phone: "(213) 555-0199" });
  assert.equal(fixture.creates[0]?.data.phoneOverride, "+12135550199");
  assert.equal("phoneOverride" in result && result.phoneOverride, "+12135550199");
  assert.equal(result.showVenmoInfo, true);
});

test("first signup can save an explicit phone while a phone-less new profile remains email-only", async (context) => {
  const fixture = createSignupFixture(context, { newProfile: true, savedPhone: null });
  const result = await fixture.caller().addWatchedClass({ ...signup, phone: "(213) 555-0199" });
  assert.equal(fixture.studentCreates.length, 1);
  assert.equal(fixture.creates[0]?.data.phoneOverride, "+12135550199");
  assert.equal(result.showVenmoInfo, true);
  assert.equal(result.isVerifiedAccount, false);

  const phoneLess = createSignupFixture(context, { newProfile: true, savedPhone: null });
  const noPhoneResult = await phoneLess.caller().addWatchedClass(signup);
  assert.equal(phoneLess.creates[0]?.data.phoneOverride, undefined);
  assert.equal(noPhoneResult.showVenmoInfo, false);
});

test("authenticated profile and section queries expose the effective phone with explicit choices taking priority", async (context) => {
  const client = createTestClient(context);
  const profiles = [student, { ...student, phone: "+12135550101" }];
  const watches = [
    { ...section, NotificationSent: [] },
    { ...section, id: "override-watch", phoneOverride: "(213) 555-0102", NotificationSent: [] },
  ];
  Object.assign(client.watchedSection, {
    findMany: async (args: Prisma.WatchedSectionFindManyArgs) => {
      assert.equal(args.where?.studentId, student.id);
      return args.select?.phoneOverride ? [{ phoneOverride: "+12135550100", cancelledAt: null }] : watches;
    },
  });
  const router = createTRPCRouter(createUserRouter());
  for (const profile of profiles) {
    const caller = router.createCaller({ prisma: client, user: profile });
    const expectedDefault = profile.phone ?? "+12135550100";
    const info = await caller.getUserInfo();
    assert.equal(info.notificationPhone, expectedDefault);
    assert.equal(info.phone, profile.phone, "inferred defaults must not masquerade as stored account numbers");
    const results = await caller.getWatchedClasses();
    assert.equal(results[0]?.notificationPhone, expectedDefault);
    assert.equal(results[0]?.phoneOverride, null);
    assert.equal(results[1]?.notificationPhone, "+12135550102");
  }
  const anonymous = router.createCaller({ prisma: client });
  await assert.rejects(anonymous.getUserInfo(), (error) => error instanceof TRPCError && error.code === "UNAUTHORIZED");
  await assert.rejects(
    anonymous.getWatchedClasses(),
    (error) => error instanceof TRPCError && error.code === "UNAUTHORIZED",
  );
});

test("applying the default phone uses a saved sibling and refuses to clear numbers when none is valid", async (context) => {
  const client = createTestClient(context);
  const updates: Prisma.WatchedSectionUpdateManyArgs[] = [];
  let savedPhone: string | null = "+12135550100";
  Object.assign(client.watchedSection, {
    findMany: async () => (savedPhone ? [{ phoneOverride: savedPhone, cancelledAt: null }] : []),
    updateMany: async (args: Prisma.WatchedSectionUpdateManyArgs) => {
      updates.push(args);
      return { count: 1 };
    },
  });
  const caller = createTRPCRouter(createUserRouter()).createCaller({ prisma: client, user: student });
  await caller.setAccountLevelPhoneToAllSections();
  assert.deepEqual(updates, [
    { where: { studentId: student.id, cancelledAt: null }, data: { phoneOverride: "+12135550100" } },
  ]);
  savedPhone = "invalid";
  await assert.rejects(caller.setAccountLevelPhoneToAllSections(), /Add a valid phone number/);
  savedPhone = null;
  await assert.rejects(caller.setAccountLevelPhoneToAllSections(), /Add a valid phone number/);
  assert.equal(updates.length, 1, "missing or invalid fallback must never clear existing overrides");
});
