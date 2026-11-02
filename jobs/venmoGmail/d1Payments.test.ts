import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { D1Executor } from "@/server/d1/executor";
import { getD1PaymentPreflight, markD1PaymentPaid } from "./d1Payments";

test("D1 receipts atomically reject ambiguous, stale, already-paid and ineligible references", async (context) => {
  const sqlite = new DatabaseSync(":memory:");
  context.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE WatchedSection (
    id TEXT PRIMARY KEY, paidId TEXT NOT NULL, semester TEXT NOT NULL,
    createdAt INTEGER, updatedAt INTEGER, isPaid INTEGER NOT NULL DEFAULT 0,
    paidNotified INTEGER NOT NULL DEFAULT 0
  )`);
  // SAFETY: These helpers use only query(); real SQLite executes every statement against the fixture schema.
  const d1 = {
    query: async (sql, params = []) => sqlite.prepare(sql).all(...params),
  } as D1Executor;
  const insert = sqlite.prepare(
    "INSERT INTO WatchedSection (id, paidId, semester, createdAt, isPaid, paidNotified) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run("valid", "12345678", "20271", 1_000, 0, 0);
  insert.run("duplicate-a", "22345678", "20271", 1_000, 0, 0);
  insert.run("duplicate-b", "22345678", "20263", 1_000, 0, 0);
  insert.run("too-new", "32345678", "20271", 5_000, 0, 0);
  insert.run("missing-age", "42345678", "20271", null, 0, 0);
  insert.run("already-paid", "52345678", "20271", 1_000, 1, 0);
  insert.run("notified", "62345678", "20271", 1_000, 0, 1);
  insert.run("legacy", "legacy", "20271", 1_000, 0, 0);
  const candidate = (rowId: string, paidId: string, semester = "20271") => ({
    rowId,
    paidId,
    semester,
    receiptCutoff: new Date(2_000),
  });
  assert.equal(await markD1PaymentPaid(d1, candidate("valid", "12345678", "20263")), 0);
  assert.equal(await markD1PaymentPaid(d1, candidate("valid", "wrong-ref")), 0);
  for (const [id, paidId] of [
    ["duplicate-a", "22345678"],
    ["too-new", "32345678"],
    ["missing-age", "42345678"],
    ["already-paid", "52345678"],
  ]) {
    assert.equal(await markD1PaymentPaid(d1, candidate(id!, paidId!)), 0);
  }
  assert.equal(await markD1PaymentPaid(d1, candidate("notified", "62345678"), true), 0);
  assert.equal(await markD1PaymentPaid(d1, candidate("valid", "12345678")), 1);
  assert.equal(await markD1PaymentPaid(d1, candidate("valid", "12345678")), 0);
  await assert.rejects(
    markD1PaymentPaid(d1, { ...candidate("legacy", "legacy"), receiptCutoff: new Date("invalid") }),
    /Invalid receipt/,
  );
  assert.deepEqual(
    { ...(await getD1PaymentPreflight(d1)) },
    {
      totalRowCount: 8,
      duplicatePaidIdGroupCount: 1,
      legacyNonEightDigitPaidIdRowCount: 1,
      inconsistentUnpaidButNotifiedRowCount: 1,
      missingCreatedAtRowCount: 1,
    },
  );
});

test("D1 preflight handles an empty database without null sums", async (context) => {
  const sqlite = new DatabaseSync(":memory:");
  context.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE WatchedSection (paidId TEXT, createdAt INTEGER, isPaid INTEGER, paidNotified INTEGER)");
  // SAFETY: The preflight uses only query(); its SELECT runs against the fixture schema in real SQLite.
  const d1 = { query: async (sql, params = []) => sqlite.prepare(sql).all(...params) } as D1Executor;
  assert.deepEqual(Object.values(await getD1PaymentPreflight(d1)), [0, 0, 0, 0, 0]);
});
