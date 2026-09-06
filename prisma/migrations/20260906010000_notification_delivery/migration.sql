BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Preserve existing notification/payment history while making retries channel-aware.
ALTER TABLE "WatchedSection"
  ADD COLUMN "notificationCycle" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "emailSentCycle" INTEGER,
  ADD COLUMN "smsSentCycle" INTEGER,
  ADD COLUMN "notificationClaimToken" TEXT,
  ADD COLUMN "notificationClaimUntil" TIMESTAMP(3);

-- Preserve partially delivered email alerts from before per-channel tracking.
UPDATE "WatchedSection" AS watch
SET "emailSentCycle" = 0
WHERE EXISTS (
  SELECT 1 FROM "NotificationSent" AS delivery
  WHERE delivery."sectionId" = watch.id
    AND delivery."createdAt" IS NOT NULL
    AND (watch."lastNotified" IS NULL OR delivery."createdAt" > watch."lastNotified")
);

ALTER TABLE "ClassInfo" ADD COLUMN "isCancelled" BOOLEAN NOT NULL DEFAULT false;

-- Unique indexes already serve these exact lookup keys.
DROP INDEX "Student_email_idx";
DROP INDEX "Student_verificationKey_idx";
DROP INDEX "ClassInfo_section_semester_idx";

COMMIT;
