import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
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
    findMany: async () => {
      queries.push("paid-reference-check");
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
      where: { id: section.id },
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
