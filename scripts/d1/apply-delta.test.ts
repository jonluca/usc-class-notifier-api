import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { createD1TestClient } from "../../src/server/d1/testing.ts";
import type { D1Executor } from "../../src/server/d1/executor.ts";
import { applyDelta, buildDeltaBatch, hashDeltaPlan, verifyDeltaState, type DeltaApplyProof } from "./apply-delta.ts";
import { deltaPlanSchema, type DeltaPlan, type DeltaChange } from "./delta.ts";
import { ALL_TABLES, TABLES, normalizeRow, quote, rawRowSchema, TableDigest, type Cell, type Table } from "./format.ts";

interface SnapshotRows {
  Student: Cell[][];
  ClassInfo: Cell[][];
  WatchedSection: Cell[][];
  NotificationSent: Cell[][];
  PaymentReference: Cell[][];
}
async function capture(executor: D1Executor): Promise<SnapshotRows> {
  const result: SnapshotRows = {
    Student: [],
    ClassInfo: [],
    WatchedSection: [],
    NotificationSent: [],
    PaymentReference: [],
  };
  for (const table of ALL_TABLES) {
    const rows = await executor.query(`SELECT * FROM ${quote(table)} ORDER BY 1 COLLATE BINARY`);
    result[table] = rows.map((row) => normalizeRow(table, rawRowSchema.parse(row)));
  }
  return result;
}
function row(table: Table, values: Record<string, Cell>): Cell[] {
  return normalizeRow(
    table,
    rawRowSchema.parse(
      Object.fromEntries(
        TABLES[table].map((column) => [
          column.name,
          values[column.name] ?? (column.nullable ? null : column.kind === "text" ? "synthetic" : 0),
        ]),
      ),
    ),
  );
}
function replace(table: Table, original: Cell[], values: Record<string, Cell>): Cell[] {
  const fields = z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .parse(Object.fromEntries(TABLES[table].map((column, i) => [column.name, original[i]])));
  return row(table, { ...fields, ...values });
}
function planFor(before: SnapshotRows, after: SnapshotRows): DeltaPlan {
  const summaries = (snapshot: SnapshotRows) =>
    Object.fromEntries(
      ALL_TABLES.map((table) => {
        const digest = new TableDigest(table);
        const sorted = [...snapshot[table]].sort((a, b) =>
          Buffer.compare(Buffer.from(z.string().parse(a[0])), Buffer.from(z.string().parse(b[0]))),
        );
        for (const value of sorted) {
          digest.add(value);
        }
        return [table, digest.finish()];
      }),
    );
  const changes: DeltaChange[] = [];
  for (const table of ALL_TABLES) {
    const left = new Map(before[table].map((value) => [z.string().parse(value[0]), value]));
    const right = new Map(after[table].map((value) => [z.string().parse(value[0]), value]));
    for (const key of new Set([...left.keys(), ...right.keys()])) {
      const old = left.get(key) ?? null;
      const next = right.get(key) ?? null;
      if (JSON.stringify(old) !== JSON.stringify(next)) {
        changes.push({
          table,
          key,
          before: old,
          after: next,
          kind: old === null ? "insert" : next === null ? "delete" : "update",
        });
      }
    }
  }
  return deltaPlanSchema.parse({
    version: 1,
    deltaId: randomUUID(),
    createdAt: new Date().toISOString(),
    preCutoverOnly: true,
    sourceIdentitySha256: "a".repeat(64),
    referencePolicy: "exact-final-distinct-before-first-D1-write",
    base: { snapshotId: randomUUID(), manifestSha256: "b".repeat(64), tables: summaries(before) },
    final: { snapshotId: randomUUID(), manifestSha256: "c".repeat(64), tables: summaries(after) },
    changes,
    validation: {
      baseDigestsVerified: true,
      finalDigestsVerified: true,
      foreignKeyViolations: 0,
      invalidStorageTypes: 0,
    },
  });
}
function proof(plan: DeltaPlan): DeltaApplyProof {
  return {
    preCutoverOnly: true,
    sourceWritersFenced: true,
    d1ApplicationWritesNeverEnabled: true,
    baselineFullyVerified: true,
    expectedDeltaSha256: hashDeltaPlan(plan),
    expectedBaseSnapshotId: plan.base.snapshotId,
    expectedFinalSnapshotId: plan.final.snapshotId,
    expectedSourceIdentitySha256: plan.sourceIdentitySha256,
  };
}
async function fixture(context: TestContext) {
  const fixture = await createD1TestClient({ installGuards: false });
  context.after(() => fixture.dispose());
  const seed = {
    Student: row("Student", {
      id: "student",
      email: "student@example.invalid",
      verificationKey: "key",
      validAccount: 1,
    }),
    ClassInfo: row("ClassInfo", {
      id: "course",
      section: "03173",
      semester: "20271",
      department: "LAW",
      courseNumber: "LAW-532",
      courseTitle: "Original",
    }),
    WatchedSection: row("WatchedSection", {
      id: "watch",
      section: "03173",
      semester: "20271",
      studentId: "student",
      classInfoId: "course",
      paidId: "12345678",
    }),
    NotificationSent: row("NotificationSent", { id: "old-note", sectionId: "watch", studentId: "student" }),
  };
  for (const [name, value] of Object.entries(seed)) {
    const table = z.enum(["Student", "ClassInfo", "WatchedSection", "NotificationSent"]).parse(name);
    await fixture.executor.query(
      `INSERT INTO ${quote(table)} (${TABLES[table].map((column) => quote(column.name)).join(",")}) VALUES (${value.map(() => "?").join(",")})`,
      value,
    );
  }
  await fixture.installGuards();
  return { ...fixture, before: await capture(fixture.executor) };
}

test("native D1 batch applies exact delta, preserves unchanged class FKs, and restores reference guards", async (context) => {
  const { executor, before } = await fixture(context);
  const after = structuredClone(before);
  after.Student[0] = replace("Student", after.Student[0]!, { phone: "+12025550100", updatedAt: 1000 });
  after.ClassInfo[0] = replace("ClassInfo", after.ClassInfo[0]!, { courseTitle: "Changed", updatedAt: 1000 });
  after.NotificationSent = [];
  after.Student.push(row("Student", { id: "student2", email: "second@example.invalid", verificationKey: "key2" }));
  after.ClassInfo.push(row("ClassInfo", { id: "course2", section: "03172", semester: "20271" }));
  after.WatchedSection.push(
    row("WatchedSection", {
      id: "watch2",
      section: "03172",
      semester: "20271",
      studentId: "student2",
      classInfoId: "course2",
      paidId: "23456789",
    }),
  );
  after.NotificationSent.push(
    row("NotificationSent", { id: "new-note", sectionId: "watch2", studentId: "student2", createdAt: 1000 }),
  );
  after.PaymentReference.push(["23456789"]);
  const plan = planFor(before, after);
  assert.equal((await verifyDeltaState(executor, plan, "before")).matches, true);
  assert.equal((await applyDelta(executor, plan, proof(plan))).outcome, "applied");
  assert.equal((await verifyDeltaState(executor, plan, "after")).matches, true);
  const actual = await capture(executor);
  assert.deepEqual(
    actual.WatchedSection.find((value) => value[0] === "watch"),
    before.WatchedSection[0],
  );
  assert.deepEqual(planFor(actual, after).changes, []);
  await assert.rejects(
    executor.query(
      `INSERT INTO WatchedSection(id,section,semester,studentId,paidId) VALUES ('reuse','99999','20273','student','12345678')`,
    ),
    /UNIQUE constraint/,
  );
  assert.deepEqual(await executor.query('SELECT * FROM "D1Invariant"'), []);
});

test("changed nullable before-value aborts before any mutation and does not remove triggers", async (context) => {
  const { executor, before } = await fixture(context);
  const after = structuredClone(before);
  after.Student[0] = replace("Student", after.Student[0]!, { phone: "+12025550100" });
  const plan = planFor(before, after);
  await executor.query("UPDATE Student SET phone='unexpected' WHERE id='student'");
  const result = await applyDelta(executor, plan, proof(plan));
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(await executor.query("SELECT phone FROM Student WHERE id='student'"), [{ phone: "unexpected" }]);
  assert.equal((await executor.query("SELECT name FROM sqlite_master WHERE type='trigger'")).length, 2);
  assert.deepEqual(await executor.query('SELECT * FROM "D1Invariant"'), []);
});

test("late foreign-key failure rolls back row writes, trigger DDL and invariant assertions", async (context) => {
  const { executor, before } = await fixture(context);
  const after = structuredClone(before);
  after.Student[0] = replace("Student", after.Student[0]!, { phone: "+12025550100" });
  after.WatchedSection.push(
    row("WatchedSection", {
      id: "bad-watch",
      section: "03172",
      semester: "20271",
      studentId: "missing",
      classInfoId: "course",
      paidId: "23456789",
    }),
  );
  after.PaymentReference.push(["23456789"]);
  const plan = planFor(before, after);
  assert.equal((await applyDelta(executor, plan, proof(plan))).outcome, "not_applied");
  assert.deepEqual(await capture(executor), before);
  assert.equal((await verifyDeltaState(executor, plan, "before")).matches, true);
});

test("lost response is reconciled by reads and never repeats the write batch", async (context) => {
  const { executor, before } = await fixture(context);
  const after = structuredClone(before);
  after.Student[0] = replace("Student", after.Student[0]!, { phone: "+12025550100" });
  const plan = planFor(before, after);
  let batches = 0;
  const lostResponse: D1Executor = {
    query: executor.query,
    batch: async (statements) => {
      batches += 1;
      await executor.batch(statements);
      throw new Error("Synthetic lost response");
    },
  };
  assert.equal((await applyDelta(lostResponse, plan, proof(plan))).outcome, "after_state_verified");
  assert.equal(batches, 1);
  assert.equal((await verifyDeltaState(executor, plan, "after")).matches, true);
});

test("ClassInfo deletion requires every affected watch in the delta and preserves its final null", async (context) => {
  const { executor, before } = await fixture(context);
  const after = structuredClone(before);
  after.ClassInfo = [];
  const incomplete = planFor(before, after);
  assert.equal((await applyDelta(executor, incomplete, proof(incomplete))).outcome, "not_applied");
  assert.deepEqual(await capture(executor), before);
  after.WatchedSection[0] = replace("WatchedSection", after.WatchedSection[0]!, { classInfoId: null });
  const plan = planFor(before, after);
  assert.equal((await applyDelta(executor, plan, proof(plan))).outcome, "applied");
  assert.deepEqual(await capture(executor), after);
});

test("reverse foreign-key deletions and final reference removal commit together", async (context) => {
  const { executor, before } = await fixture(context);
  const after: SnapshotRows = {
    Student: [],
    ClassInfo: [],
    WatchedSection: [],
    NotificationSent: [],
    PaymentReference: [],
  };
  const plan = planFor(before, after);
  assert.equal((await applyDelta(executor, plan, proof(plan))).outcome, "applied");
  assert.equal((await verifyDeltaState(executor, plan, "after")).matches, true);
  assert.deepEqual(await capture(executor), after);
});

test("proof and payload bounds are checked before any executor call", async (context) => {
  const { before } = await fixture(context);
  const after = structuredClone(before);
  after.Student[0] = replace("Student", after.Student[0]!, { phone: "+12025550100" });
  const plan = planFor(before, after);
  let calls = 0;
  const neverExecute: D1Executor = {
    query: async () => {
      calls += 1;
      throw new Error("Unexpected read");
    },
    batch: async () => {
      calls += 1;
      throw new Error("Unexpected write");
    },
  };
  await assert.rejects(
    applyDelta(neverExecute, plan, { ...proof(plan), expectedDeltaSha256: "wrong" }),
    /proof required/,
  );
  const oversized = structuredClone(after);
  oversized.ClassInfo[0] = replace("ClassInfo", oversized.ClassInfo[0]!, { courseTitle: "x".repeat(2_000_000) });
  const hugePlan = planFor(before, oversized);
  await assert.rejects(applyDelta(neverExecute, hugePlan, proof(hugePlan)), /request limit/);
  const duplicate = { ...plan, changes: [plan.changes[0]!, plan.changes[0]!] };
  assert.throws(() => buildDeltaBatch(duplicate), /duplicate row/);
  assert.equal(calls, 0);
  const batch = buildDeltaBatch(plan);
  assert.ok(batch.length <= 256);
  assert.ok(batch.every((statement) => (statement.params?.length ?? 0) <= 100));

  const largeBefore = structuredClone(before);
  for (let i = 0; i < 100; i++) {
    largeBefore.Student.push(
      row("Student", {
        id: `bulk-${i}`,
        email: `bulk-${i}@example.invalid`,
        verificationKey: `bulk-key-${i}`,
      }),
    );
  }
  const largeAfter = structuredClone(largeBefore);
  largeAfter.Student = largeAfter.Student.map((value) =>
    value[0] === "student" ? value : replace("Student", value, { phone: "+12025550100" }),
  );
  const hundred = planFor(largeBefore, largeAfter);
  assert.equal(hundred.changes.length, 100);
  const hundredBatch = buildDeltaBatch(hundred);
  assert.ok(hundredBatch.length <= 256);
  assert.ok(hundredBatch.every((statement) => (statement.params?.length ?? 0) <= 100));
  assert.throws(() => buildDeltaBatch({ ...hundred, changes: [...hundred.changes, hundred.changes[0]!] }), /Too big/);
});
