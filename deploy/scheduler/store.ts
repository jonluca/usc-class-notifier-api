import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { D1Executor } from "../../src/server/d1/executor.ts";

export const SCHEDULER_LEASE_MS = 20 * 60 * 1000;
export const SCHEDULER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const GMAIL_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const epoch = z.number().int().nonnegative().safe();
const identity = z.string().min(1).max(256);
const claimSchema = z.object({ id: identity, kind: identity, scope: identity, scheduledAt: epoch }).strict();
const summarySchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  z.union([z.number().finite(), z.boolean(), z.null()]),
);
export type SchedulerSummary = z.infer<typeof summarySchema>;
export type SchedulerClaim = z.infer<typeof claimSchema>;
export type SchedulerClaimResult =
  | { status: "claimed"; token: string; attempts: number }
  | { status: "completed" | "busy" };
const runSchema = z.object({
  id: identity,
  kind: identity,
  scope: identity,
  scheduledAt: epoch,
  status: z.enum(["running", "completed", "failed"]),
  attempts: z.number().int().positive(),
  startedAt: epoch,
  finishedAt: epoch.nullable(),
  summaryJSON: z.string().nullable(),
  errorCode: z.string().nullable(),
  alerted: z.union([z.literal(0), z.literal(1)]),
});

/** Atomic native-D1 state transitions; never retry an ambiguous write response here. */
export class SchedulerStore {
  constructor(private readonly executor: D1Executor) {}

  async isEnabled(): Promise<boolean> {
    const rows = await this.executor.query<{ enabled: number }>(
      "SELECT enabled FROM SchedulerControl WHERE id = 'scheduler'",
    );
    return rows[0]?.enabled === 1;
  }

  async claim(input: SchedulerClaim, now = Date.now()): Promise<SchedulerClaimResult> {
    const job = claimSchema.parse(input);
    epoch.parse(now);
    const expiresAt = epoch.parse(now + SCHEDULER_LEASE_MS);
    const token = randomUUID();
    const result = await this.executor.batch([
      {
        sql: `INSERT INTO SchedulerLease(scope, owner, expiresAt)
          SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM SchedulerControl WHERE id = 'scheduler' AND enabled = 1)
            AND NOT EXISTS (SELECT 1 FROM SchedulerRun WHERE id = ? AND
              (status = 'completed' OR kind <> ? OR scope <> ? OR scheduledAt <> ?))
          ON CONFLICT(scope) DO UPDATE SET owner = excluded.owner, expiresAt = excluded.expiresAt
          WHERE SchedulerLease.expiresAt <= ?`,
        params: [job.scope, token, expiresAt, job.id, job.kind, job.scope, job.scheduledAt, now],
      },
      {
        sql: `UPDATE SchedulerRun SET status = 'failed', finishedAt = ?, errorCode = 'lease_expired'
          WHERE scope = ? AND status = 'running' AND token <> ?
            AND EXISTS (SELECT 1 FROM SchedulerLease WHERE scope = ? AND owner = ? AND expiresAt > ?)`,
        params: [now, job.scope, token, job.scope, token, now],
      },
      {
        sql: `INSERT INTO SchedulerRun
          (id, kind, scope, scheduledAt, status, attempts, token, startedAt)
          SELECT ?, ?, ?, ?, 'running', 1, ?, ?
          WHERE EXISTS (SELECT 1 FROM SchedulerLease WHERE scope = ? AND owner = ? AND expiresAt > ?)
          ON CONFLICT(id) DO UPDATE SET status = 'running', attempts = SchedulerRun.attempts + 1,
            token = excluded.token, startedAt = excluded.startedAt, finishedAt = NULL, summaryJSON = NULL, errorCode = NULL
          WHERE SchedulerRun.status <> 'completed' AND SchedulerRun.kind = excluded.kind
            AND SchedulerRun.scope = excluded.scope AND SchedulerRun.scheduledAt = excluded.scheduledAt`,
        params: [job.id, job.kind, job.scope, job.scheduledAt, token, now, job.scope, token, now],
      },
      {
        sql: "SELECT status, token, attempts FROM SchedulerRun WHERE id = ? AND kind = ? AND scope = ? AND scheduledAt = ?",
        params: [job.id, job.kind, job.scope, job.scheduledAt],
      },
    ]);
    const row = result[3]?.results[0];
    if (row?.status === "running" && row.token === token) {
      return { status: "claimed", token, attempts: z.number().int().positive().parse(row.attempts) };
    }
    return { status: row?.status === "completed" ? "completed" : "busy" };
  }

  async complete(
    id: string,
    scope: string,
    token: string,
    summary: SchedulerSummary,
    now = Date.now(),
  ): Promise<boolean> {
    const value = summarySchema.parse(summary);
    const json = JSON.stringify(value);
    if (Object.keys(value).length > 32 || new TextEncoder().encode(json).length > 4096) {
      throw new RangeError("Scheduler summary exceeds aggregate bounds");
    }
    return this.finish(id, scope, token, "completed", json, null, now);
  }

  async fail(id: string, scope: string, token: string, errorCode: string, now = Date.now()): Promise<boolean> {
    const code = z
      .string()
      .regex(/^[a-zA-Z0-9_.:-]{1,80}$/)
      .parse(errorCode);
    return this.finish(id, scope, token, "failed", null, code, now);
  }

  private async finish(
    id: string,
    scope: string,
    token: string,
    status: "completed" | "failed",
    summary: string | null,
    errorCode: string | null,
    now: number,
  ): Promise<boolean> {
    identity.parse(id);
    identity.parse(scope);
    identity.parse(token);
    epoch.parse(now);
    const result = await this.executor.batch([
      {
        sql: `UPDATE SchedulerRun SET status = ?, finishedAt = ?, summaryJSON = ?, errorCode = ?
          WHERE id = ? AND scope = ? AND token = ? AND status = 'running'
            AND EXISTS (SELECT 1 FROM SchedulerLease WHERE scope = ? AND owner = ? AND expiresAt > ?)
          RETURNING id`,
        params: [status, now, summary, errorCode, id, scope, token, scope, token, now],
      },
      {
        // changes() refers to the preceding owned-run UPDATE inside the same atomic batch.
        sql: "DELETE FROM SchedulerLease WHERE scope = ? AND owner = ? AND changes() = 1",
        params: [scope, token],
      },
    ]);
    return result[0]?.results.length === 1;
  }

  /** Reserve exhausted Gmail alerts atomically across jobs, including uncertain send outcomes. */
  async claimAlert(id: string, now = Date.now()): Promise<boolean> {
    identity.parse(id);
    epoch.parse(now);
    const result = await this.executor.query<{ id: string }>(
      `UPDATE SchedulerRun SET alerted = 1,
          summaryJSON = json_set(COALESCE(summaryJSON, '{}'), '$.alertReservedAt', ?)
        WHERE id = ? AND kind = 'gmail' AND alerted = 0 AND status = 'failed' AND attempts >= 3
          AND NOT EXISTS (
            SELECT 1 FROM SchedulerRun
            WHERE kind = 'gmail' AND alerted = 1
              AND COALESCE(json_extract(summaryJSON, '$.alertReservedAt'), finishedAt, startedAt) > ?
          )
        RETURNING id`,
      [now, id, now - GMAIL_ALERT_COOLDOWN_MS],
    );
    return result.length === 1;
  }

  async health(now = Date.now()) {
    epoch.parse(now);
    // A single read-only batch keeps totals, leases and latest runs at one snapshot.
    const rows = await this.executor.batch([
      { sql: "SELECT enabled FROM SchedulerControl WHERE id = 'scheduler'" },
      {
        sql: `SELECT count(*) AS total, COALESCE(sum(status = 'running'), 0) AS running,
          COALESCE(sum(status = 'completed'), 0) AS completed, COALESCE(sum(status = 'failed'), 0) AS failed,
          COALESCE(sum(status = 'running' AND NOT EXISTS
            (SELECT 1 FROM SchedulerLease WHERE scope = SchedulerRun.scope AND owner = SchedulerRun.token AND expiresAt > ?)), 0) AS deadJobs
          FROM SchedulerRun`,
        params: [now],
      },
      {
        sql: "SELECT COALESCE(sum(expiresAt > ?), 0) AS activeLeases, COALESCE(sum(expiresAt <= ?), 0) AS expiredLeases FROM SchedulerLease",
        params: [now, now],
      },
      {
        sql: `SELECT kind, count(*) AS total, sum(status = 'completed') AS completed, sum(status = 'failed') AS failed,
          max(CASE WHEN status = 'completed' THEN finishedAt END) AS lastSuccessfulAt FROM SchedulerRun GROUP BY kind ORDER BY kind`,
      },
      {
        sql: `SELECT id, kind, scope, scheduledAt, status, attempts, startedAt, finishedAt, summaryJSON, errorCode, alerted FROM
          (SELECT *, row_number() OVER (PARTITION BY kind ORDER BY scheduledAt DESC, startedAt DESC, id DESC) AS rank FROM SchedulerRun)
          WHERE rank = 1 ORDER BY kind`,
      },
    ]);
    const count = z.number().int().nonnegative();
    const totals = z
      .object({ total: count, running: count, completed: count, failed: count, deadJobs: count })
      .parse(rows[1]?.results[0]);
    const leases = z.object({ activeLeases: count, expiredLeases: count }).parse(rows[2]?.results[0]);
    const kinds = z
      .array(
        z.object({ kind: identity, total: count, completed: count, failed: count, lastSuccessfulAt: epoch.nullable() }),
      )
      .parse(rows[3]?.results);
    const latest = z.array(runSchema).parse(rows[4]?.results);
    return {
      enabled: rows[0]?.results[0]?.enabled === 1,
      counts: totals,
      ...leases,
      kinds: kinds.map((kind) => {
        const run = latest.find((entry) => entry.kind === kind.kind);
        if (!run) {
          throw new Error("Scheduler health snapshot is incomplete");
        }
        const { summaryJSON, ...metadata } = run;
        return {
          ...kind,
          latest: { ...metadata, summary: summaryJSON ? summarySchema.parse(JSON.parse(summaryJSON)) : null },
        };
      }),
    };
  }

  async prune(before: number, now = Date.now()): Promise<number> {
    epoch.parse(before);
    epoch.parse(now);
    if (before > now - SCHEDULER_RETENTION_MS) {
      throw new RangeError("Scheduler retention must preserve at least 14 days");
    }
    const result = await this.executor.batch([
      {
        sql: `UPDATE SchedulerRun SET status = 'failed', finishedAt = ?, errorCode = 'lease_expired'
          WHERE status = 'running' AND NOT EXISTS
            (SELECT 1 FROM SchedulerLease WHERE scope = SchedulerRun.scope AND owner = SchedulerRun.token AND expiresAt > ?)`,
        params: [now, now],
      },
      { sql: "DELETE FROM SchedulerLease WHERE expiresAt <= ?", params: [now] },
      { sql: "DELETE FROM SchedulerRun WHERE scheduledAt < ? AND status <> 'running'", params: [before] },
    ]);
    return result[2]?.meta.changes ?? 0;
  }
}
