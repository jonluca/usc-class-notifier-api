import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createD1TestClient } from "../../src/server/d1/testing.ts";
import { SchedulerStore, SCHEDULER_LEASE_MS, SCHEDULER_RETENTION_MS } from "./store.ts";

async function fixture() {
  const local = await createD1TestClient();
  const sql = await readFile(new URL("../../prisma/d1/migrations/0003_scheduler.sql", import.meta.url), "utf8");
  for (const statement of sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .filter((value) => value.trim())) {
    await local.native.prepare(statement).run();
  }
  const store = new SchedulerStore(local.executor);
  return {
    ...local,
    store,
    enable: () => local.executor.query("UPDATE SchedulerControl SET enabled = 1 WHERE id = 'scheduler'"),
  };
}

const job = {
  id: "availability:20263:CSCI:1000",
  kind: "availability",
  scope: "availability:20263:CSCI",
  scheduledAt: 1000,
};

test("scheduler is disabled by default and concurrent duplicates claim exactly once", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.store.isEnabled(), false);
    assert.deepEqual(await f.store.claim(job, 1000), { status: "busy" });
    assert.equal((await f.store.health(1000)).counts.total, 0);
    await f.enable();
    const attempts = await Promise.all(Array.from({ length: 8 }, () => f.store.claim(job, 1000)));
    assert.equal(attempts.filter((value) => value.status === "claimed").length, 1);
    assert.equal(attempts.filter((value) => value.status === "busy").length, 7);
    const claimed = attempts.find((value) => value.status === "claimed");
    assert.ok(claimed && claimed.status === "claimed");
    assert.equal(await f.store.complete(job.id, job.scope, claimed.token, { processedWatches: 4 }, 1010), true);
    assert.deepEqual(await f.store.claim(job, 1020), { status: "completed" });
    const health = await f.store.health(1020);
    assert.equal(health.counts.completed, 1);
    assert.equal(health.counts.total, 1);
    assert.equal(health.activeLeases, 0);
    assert.equal(health.kinds[0]?.lastSuccessfulAt, 1010);
    assert.equal(health.kinds[0]?.latest?.attempts, 1);
    assert.deepEqual(health.kinds[0]?.latest?.summary, { processedWatches: 4 });
    assert.equal(JSON.stringify(health).includes(claimed.token), false, "health must not expose attempt tokens");
  } finally {
    await f.dispose();
  }
});

test("distinct overlapping jobs cannot hold the same scope and independent scopes proceed", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const overlap = { ...job, id: "availability:20263:CSCI:2000", scheduledAt: 2000 };
    const outcomes = await Promise.all([f.store.claim(job, 2000), f.store.claim(overlap, 2000)]);
    assert.equal(outcomes.filter((value) => value.status === "claimed").length, 1);
    assert.equal(outcomes.filter((value) => value.status === "busy").length, 1);
    const separate = await f.store.claim({ ...job, id: "other", scope: "availability:20263:EE" }, 2000);
    assert.equal(separate.status, "claimed");
    const health = await f.store.health(2000);
    assert.equal(health.activeLeases, 2);
    assert.equal(health.counts.running, 2);
    assert.equal(health.counts.total, 2, "busy attempts do not create phantom runs");
  } finally {
    await f.dispose();
  }
});

test("expired same-job claims recover with a new token and stale attempts cannot finish or release them", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const first = await f.store.claim(job, 1000);
    assert.equal(first.status, "claimed");
    assert.ok(first.status === "claimed");
    const expired = 1000 + SCHEDULER_LEASE_MS;
    assert.equal(await f.store.complete(job.id, job.scope, first.token, {}, expired), false);
    const dead = await f.store.health(expired);
    assert.equal(dead.counts.deadJobs, 1);
    assert.equal(dead.expiredLeases, 1);
    const replacement = await f.store.claim(job, expired + 1);
    assert.ok(replacement.status === "claimed");
    assert.notEqual(replacement.token, first.token);
    assert.equal(first.attempts, 1);
    assert.equal(replacement.attempts, 2);
    assert.equal(await f.store.complete(job.id, job.scope, first.token, { processedWatches: 999 }, expired + 2), false);
    assert.equal(await f.store.fail(job.id, job.scope, first.token, "source_unavailable", expired + 2), false);
    const running = await f.store.health(expired + 2);
    assert.equal(running.activeLeases, 1);
    assert.equal(running.counts.running, 1);
    assert.equal(running.kinds[0]?.latest?.attempts, 2);
    assert.equal(
      await f.store.complete(job.id, job.scope, replacement.token, { processedWatches: 3 }, expired + 3),
      true,
    );
    assert.equal((await f.store.health(expired + 3)).activeLeases, 0);
  } finally {
    await f.dispose();
  }
});

test("a later scope holder marks an abandoned different job failed without stale cleanup touching its lease", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const first = await f.store.claim(job, 1000);
    assert.ok(first.status === "claimed");
    const now = 1001 + SCHEDULER_LEASE_MS;
    const secondJob = { ...job, id: "next", scheduledAt: now };
    const second = await f.store.claim(secondJob, now);
    assert.ok(second.status === "claimed");
    const old = await f.executor.query<{ status: string; errorCode: string }>(
      "SELECT status, errorCode FROM SchedulerRun WHERE id = ?",
      [job.id],
    );
    assert.deepEqual(old, [{ status: "failed", errorCode: "lease_expired" }]);
    assert.equal(await f.store.fail(job.id, job.scope, first.token, "late_failure", now + 1), false);
    assert.equal((await f.store.health(now + 1)).activeLeases, 1);
    assert.equal(await f.store.complete(secondJob.id, secondJob.scope, second.token, {}, now + 2), true);
  } finally {
    await f.dispose();
  }
});

test("failed runs release their own lease and retry the same identity with an incremented attempt", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const first = await f.store.claim(job, 1000);
    assert.ok(first.status === "claimed");
    assert.equal(await f.store.fail(job.id, job.scope, first.token, "source_timeout", 1001), true);
    assert.equal((await f.store.health(1001)).activeLeases, 0);
    const next = await f.store.claim(job, 1002);
    assert.ok(next.status === "claimed");
    assert.notEqual(first.token, next.token);
    assert.equal(await f.store.complete(job.id, job.scope, next.token, { changedSections: 0 }, 1003), true);
    assert.deepEqual(
      await f.store.claim({ ...job, scope: "different" }, 1004),
      { status: "busy" },
      "run IDs cannot be rebound to another identity",
    );
    const health = await f.store.health(1004);
    assert.equal(health.kinds[0]?.latest?.attempts, 2);
    assert.equal(health.kinds[0]?.latest?.errorCode, null);
    assert.equal(health.activeLeases, 0);
  } finally {
    await f.dispose();
  }
});

test("pruning keeps fourteen days and all active leases, while cleaning old dead runs", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const first = await f.store.claim(job, 1000);
    assert.ok(first.status === "claimed");
    assert.equal(await f.store.complete(job.id, job.scope, first.token, {}, 1001), true);
    const dead = { ...job, id: "dead", scope: "dead" };
    assert.equal((await f.store.claim(dead, 1000)).status, "claimed");
    const now = SCHEDULER_RETENTION_MS + 10_000;
    const active = { ...job, id: "active", scope: "active" };
    assert.equal((await f.store.claim(active, now)).status, "claimed");
    const recent = { ...job, id: "recent", scope: "recent", scheduledAt: now - 100 };
    const recentClaim = await f.store.claim(recent, now);
    assert.ok(recentClaim.status === "claimed");
    await f.store.complete(recent.id, recent.scope, recentClaim.token, {}, now + 1);
    await assert.rejects(f.store.prune(now, now + 1), /14 days/);
    assert.equal(await f.store.prune(now - SCHEDULER_RETENTION_MS, now + 1), 2);
    const health = await f.store.health(now + 1);
    assert.equal(health.counts.total, 2);
    assert.equal(health.counts.running, 1);
    assert.equal(health.counts.completed, 1);
    assert.equal(health.expiredLeases, 0);
    assert.equal(health.activeLeases, 1);
  } finally {
    await f.dispose();
  }
});

test("alert reservation is atomic, survives job retries and ignores completed runs", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const first = await f.store.claim(job, 1000);
    assert.ok(first.status === "claimed");
    const reservations = await Promise.all(Array.from({ length: 8 }, () => f.store.claimAlert(job.id)));
    assert.equal(reservations.filter(Boolean).length, 1);
    await f.store.fail(job.id, job.scope, first.token, "gmail_page_timeout", 1001);
    const retry = await f.store.claim(job, 1002);
    assert.ok(retry.status === "claimed");
    assert.equal(await f.store.claimAlert(job.id), false);
    await f.store.complete(job.id, job.scope, retry.token, {}, 1003);
    assert.equal((await f.store.health(1003)).kinds[0]?.latest.alerted, 1);
    const secondJob = { ...job, id: "completed-without-alert", scope: "other" };
    const second = await f.store.claim(secondJob, 1004);
    assert.ok(second.status === "claimed");
    await f.store.complete(secondJob.id, secondJob.scope, second.token, {}, 1005);
    assert.equal(await f.store.claimAlert(secondJob.id), false);
    assert.equal(await f.store.claimAlert("missing-run"), false);
  } finally {
    await f.dispose();
  }
});
