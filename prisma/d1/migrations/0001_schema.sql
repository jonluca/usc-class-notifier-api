-- DateTime values use epoch milliseconds, matching PrismaD1.
-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" INTEGER DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    "updatedAt" INTEGER,
    "email" TEXT NOT NULL,
    "verificationKey" TEXT NOT NULL,
    "phone" TEXT,
    "validAccount" BOOLEAN NOT NULL DEFAULT false,
    "uscID" TEXT
);

-- CreateTable
CREATE TABLE "WatchedSection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" INTEGER DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    "updatedAt" INTEGER,
    "section" TEXT NOT NULL,
    "semester" TEXT NOT NULL,
    "lastNotified" INTEGER,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" INTEGER,
    "notificationCycle" INTEGER NOT NULL DEFAULT 0,
    "emailSentCycle" INTEGER,
    "smsSentCycle" INTEGER,
    "notificationClaimToken" TEXT,
    "notificationClaimUntil" INTEGER,
    "paidId" TEXT NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "paidNotified" BOOLEAN NOT NULL DEFAULT false,
    "phoneOverride" TEXT,
    "studentId" TEXT NOT NULL,
    "classInfoId" TEXT,
    CONSTRAINT "WatchedSection_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WatchedSection_classInfoId_fkey" FOREIGN KEY ("classInfoId") REFERENCES "ClassInfo" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotificationSent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" INTEGER DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    "updatedAt" INTEGER,
    "sectionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    CONSTRAINT "NotificationSent_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "WatchedSection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "NotificationSent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClassInfo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" INTEGER DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    "updatedAt" INTEGER,
    "department" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "courseNumber" TEXT NOT NULL,
    "courseTitle" TEXT NOT NULL,
    "semester" TEXT NOT NULL,
    "instructor" TEXT,
    "type" TEXT,
    "prefix" TEXT,
    "units" TEXT,
    "day" TEXT,
    "session" TEXT,
    "location" TEXT,
    "isDistanceLearning" BOOLEAN NOT NULL DEFAULT false,
    "hasDClearance" BOOLEAN NOT NULL DEFAULT false,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "PaymentReference" (
    "paidId" TEXT NOT NULL PRIMARY KEY
);

-- CreateTable
CREATE TABLE "D1Invariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "value" INTEGER NOT NULL CHECK ("value" = 1)
);

-- CreateIndex
CREATE INDEX "Student_phone_idx" ON "Student"("phone");

-- CreateIndex
CREATE INDEX "Student_email_verificationKey_idx" ON "Student"("email", "verificationKey");

-- CreateIndex
CREATE UNIQUE INDEX "Student_email_key" ON "Student"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Student_verificationKey_key" ON "Student"("verificationKey");

-- CreateIndex
CREATE INDEX "WatchedSection_semester_notified_section_idx" ON "WatchedSection"("semester", "notified", "section");

-- CreateIndex
CREATE INDEX "WatchedSection_section_idx" ON "WatchedSection"("section");

-- CreateIndex
CREATE INDEX "WatchedSection_semester_idx" ON "WatchedSection"("semester");

-- CreateIndex
CREATE INDEX "WatchedSection_notified_idx" ON "WatchedSection"("notified");

-- CreateIndex
CREATE INDEX "WatchedSection_isPaid_idx" ON "WatchedSection"("isPaid");

-- CreateIndex
CREATE INDEX "WatchedSection_isPaid_paidNotified_idx" ON "WatchedSection"("isPaid", "paidNotified");

-- CreateIndex
CREATE INDEX "WatchedSection_phoneOverride_idx" ON "WatchedSection"("phoneOverride");

-- CreateIndex
CREATE INDEX "WatchedSection_classInfoId_idx" ON "WatchedSection"("classInfoId");

-- CreateIndex
CREATE INDEX "WatchedSection_createdAt_idx" ON "WatchedSection"("createdAt");

-- CreateIndex
CREATE INDEX "WatchedSection_studentId_idx" ON "WatchedSection"("studentId");

-- CreateIndex
CREATE INDEX "WatchedSection_studentId_cancelledAt_idx" ON "WatchedSection"("studentId", "cancelledAt");

-- CreateIndex
CREATE INDEX "WatchedSection_paidId_idx" ON "WatchedSection"("paidId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchedSection_semester_paidId_key" ON "WatchedSection"("semester", "paidId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchedSection_semester_studentId_section_key" ON "WatchedSection"("semester", "studentId", "section");

-- CreateIndex
CREATE INDEX "NotificationSent_sectionId_idx" ON "NotificationSent"("sectionId");

-- CreateIndex
CREATE INDEX "NotificationSent_studentId_idx" ON "NotificationSent"("studentId");

-- CreateIndex
CREATE INDEX "ClassInfo_department_idx" ON "ClassInfo"("department");

-- CreateIndex
CREATE INDEX "ClassInfo_prefix_idx" ON "ClassInfo"("prefix");

-- CreateIndex
CREATE INDEX "ClassInfo_courseNumber_idx" ON "ClassInfo"("courseNumber");

-- CreateIndex
CREATE INDEX "ClassInfo_semester_idx" ON "ClassInfo"("semester");

-- CreateIndex
CREATE UNIQUE INDEX "ClassInfo_section_semester_key" ON "ClassInfo"("section", "semester");

