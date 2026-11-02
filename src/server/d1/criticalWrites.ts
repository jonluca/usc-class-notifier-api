import { randomUUID } from "node:crypto";
import type { D1Executor } from "./executor";
import { generatePaidReferenceCandidates } from "../paidReference";

// A trigger reserves every newly assigned reference in PaymentReference. Keep
// reservations after a watch is deleted or rotated: old receipts must never pay
// a different alert. Only retry this specific collision, not other constraints.
function isReferenceCollision(error: Error): boolean {
  return (
    /UNIQUE constraint failed: (?:main\.)?PaymentReference\.paidId/i.test(error.message) ||
    /UNIQUE constraint failed: WatchedSection\.semester, WatchedSection\.paidId(?:$|:|\n)/i.test(error.message) ||
    (error.cause instanceof Error && error.cause !== error && isReferenceCollision(error.cause))
  );
}

export async function withD1PaidReference<T>(
  operation: (paidId: string) => Promise<T>,
  candidates = generatePaidReferenceCandidates(),
): Promise<T> {
  for (const paidId of candidates) {
    try {
      return await operation(paidId);
    } catch (error) {
      if (!(error instanceof Error) || !isReferenceCollision(error)) {
        throw error;
      }
    }
  }
  throw new Error("Could not allocate a globally unique payment reference");
}

interface WatchIdentity {
  studentId: string;
  section: string;
  semester: string;
  classInfoId: string;
}

export async function createD1Watch(
  executor: D1Executor,
  input: WatchIdentity & { phoneOverride?: string },
  candidates?: string[],
): Promise<string> {
  return withD1PaidReference(async (paidId) => {
    const id = randomUUID();
    const now = Date.now();
    const rows = await executor.query<{ id: string }>(
      `INSERT INTO WatchedSection
       (id, createdAt, updatedAt, section, semester, studentId, classInfoId, paidId, phoneOverride)
       SELECT ?, ?, ?, ?, ?, ?, id, ?, ? FROM ClassInfo
       WHERE id = ? AND section = ? AND semester = ? AND isCancelled = 0
       RETURNING id`,
      [
        id,
        now,
        now,
        input.section,
        input.semester,
        input.studentId,
        paidId,
        input.phoneOverride ?? null,
        input.classInfoId,
        input.section,
        input.semester,
      ],
    );
    if (!rows.length) {
      throw new Error("The class changed while signing up. Refresh and try again.");
    }
    return rows[0]!.id;
  }, candidates);
}

export async function readdD1Watch(
  executor: D1Executor,
  input: WatchIdentity & { id: string; phoneOverride?: string },
  candidates?: string[],
): Promise<void> {
  await withD1PaidReference(async (paidId) => {
    const rows = await executor.query<{ id: string }>(
      `UPDATE WatchedSection SET cancelledAt = NULL, notified = 0,
         notificationCycle = notificationCycle + 1, updatedAt = ?, classInfoId = ?,
         phoneOverride = COALESCE(?, phoneOverride),
         paidId = CASE WHEN isPaid = 0 AND (length(paidId) != 8 OR paidId GLOB '*[^0-9]*')
                       THEN ? ELSE paidId END
       WHERE id = ? AND studentId = ? AND section = ? AND semester = ?
         AND EXISTS (SELECT 1 FROM ClassInfo WHERE id = ? AND section = ? AND semester = ? AND isCancelled = 0)
       RETURNING id`,
      [
        Date.now(),
        input.classInfoId,
        input.phoneOverride ?? null,
        paidId,
        input.id,
        input.studentId,
        input.section,
        input.semester,
        input.classInfoId,
        input.section,
        input.semester,
      ],
    );
    if (!rows.length) {
      throw new Error("This alert or class changed while signing up. Refresh and try again.");
    }
  }, candidates);
}

export async function rotateD1PaidReference(
  executor: D1Executor,
  row: { id: string; paidId: string },
  candidates?: string[],
): Promise<number> {
  return withD1PaidReference(async (paidId) => {
    const rows = await executor.query<{ id: string }>(
      `UPDATE WatchedSection SET paidId = ?, updatedAt = ?
       WHERE id = ? AND paidId = ? AND isPaid = 0
         AND (length(paidId) != 8 OR paidId GLOB '*[^0-9]*') RETURNING id`,
      [paidId, Date.now(), row.id, row.paidId],
    );
    return rows.length;
  }, candidates);
}

export async function repairD1PaidReferences(executor: D1Executor) {
  let cursor = "";
  let eligible = 0;
  let repaired = 0;
  while (true) {
    const rows = await executor.query<{ id: string; paidId: string }>(
      `SELECT id, paidId FROM WatchedSection WHERE id > ? AND isPaid = 0
       AND (length(paidId) != 8 OR paidId GLOB '*[^0-9]*') ORDER BY id LIMIT 100`,
      [cursor],
    );
    if (!rows.length) {
      break;
    }
    eligible += rows.length;
    for (const row of rows) {
      repaired += await rotateD1PaidReference(executor, row);
    }
    cursor = rows.at(-1)!.id;
  }
  return { eligible, repaired };
}

export async function moveD1Watch(
  executor: D1Executor,
  input: WatchIdentity & { id: string; previousSection: string; notificationCycle: number; legacyCutoff: number },
): Promise<boolean> {
  const now = Date.now();
  const rows = await executor.query<{ id: string }>(
    `UPDATE WatchedSection SET section = ?, classInfoId = ?, notified = 0, lastNotified = NULL,
       notificationCycle = notificationCycle + 1, notificationClaimToken = NULL,
       notificationClaimUntil = NULL, updatedAt = ?
     WHERE id = ? AND studentId = ? AND semester = ? AND section = ? AND notificationCycle = ?
       AND isPaid = 1 AND cancelledAt IS NULL AND smsSentCycle IS NULL
       AND (notificationClaimUntil IS NULL OR notificationClaimUntil <= ?)
       AND (lastNotified IS NULL OR lastNotified >= ?)
       AND NOT EXISTS (SELECT 1 FROM NotificationSent WHERE sectionId = WatchedSection.id
         AND (createdAt IS NULL OR createdAt < ?))
       AND EXISTS (SELECT 1 FROM ClassInfo WHERE id = ? AND section = ? AND semester = ? AND isCancelled = 0)
     RETURNING id`,
    [
      input.section,
      input.classInfoId,
      now,
      input.id,
      input.studentId,
      input.semester,
      input.previousSection,
      input.notificationCycle,
      now,
      input.legacyCutoff,
      input.legacyCutoff,
      input.classInfoId,
      input.section,
      input.semester,
    ],
  );
  return rows.length === 1;
}

export async function recordD1EmailDelivery(
  executor: D1Executor,
  input: { id: string; studentId: string; claimToken: string; notificationCycle: number },
): Promise<void> {
  const assertionId = randomUUID();
  const now = Date.now();
  // A zero-row UPDATE is not a batch error. The CHECK assertion deliberately
  // aborts the entire batch so stale claims cannot leave phantom delivery rows.
  await executor.batch([
    {
      sql: `UPDATE WatchedSection SET emailSentCycle = ?, updatedAt = ?
            WHERE id = ? AND studentId = ? AND notificationClaimToken = ? AND notificationCycle = ?`,
      params: [input.notificationCycle, now, input.id, input.studentId, input.claimToken, input.notificationCycle],
    },
    {
      sql: "INSERT INTO D1Invariant(id, value) VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)",
      params: [assertionId],
    },
    {
      sql: "INSERT INTO NotificationSent(id, createdAt, updatedAt, sectionId, studentId) VALUES (?, ?, ?, ?, ?)",
      params: [randomUUID(), now, now, input.id, input.studentId],
    },
    { sql: "DELETE FROM D1Invariant WHERE id = ?", params: [assertionId] },
  ]);
}
