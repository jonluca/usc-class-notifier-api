-- Scheduler stays disabled until the previous scheduler is paused.
CREATE TABLE "SchedulerControl" (
  "id" TEXT NOT NULL PRIMARY KEY CHECK ("id" = 'scheduler'),
  "enabled" INTEGER NOT NULL DEFAULT 0 CHECK ("enabled" IN (0, 1))
);
INSERT INTO "SchedulerControl" ("id", "enabled") VALUES ('scheduler', 0);

CREATE TABLE "SchedulerRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "scheduledAt" INTEGER NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('running', 'completed', 'failed')),
  "attempts" INTEGER NOT NULL CHECK ("attempts" > 0),
  "token" TEXT NOT NULL,
  "startedAt" INTEGER NOT NULL,
  "finishedAt" INTEGER,
  "summaryJSON" TEXT CHECK ("summaryJSON" IS NULL OR json_valid("summaryJSON")),
  "errorCode" TEXT,
  "alerted" INTEGER NOT NULL DEFAULT 0 CHECK ("alerted" IN (0, 1))
);
CREATE INDEX "SchedulerRun_scheduledAt_idx" ON "SchedulerRun" ("scheduledAt");
CREATE INDEX "SchedulerRun_kind_scheduledAt_idx" ON "SchedulerRun" ("kind", "scheduledAt" DESC);
CREATE INDEX "SchedulerRun_scope_status_idx" ON "SchedulerRun" ("scope", "status");

CREATE TABLE "SchedulerLease" (
  "scope" TEXT NOT NULL PRIMARY KEY,
  "owner" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL
);
CREATE INDEX "SchedulerLease_expiresAt_idx" ON "SchedulerLease" ("expiresAt");
