import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { D1Executor, D1Statement, D1Value } from "../../src/server/d1/executor.ts";
import { MAX_BATCH_STATEMENTS, MAX_REQUEST_BYTES, validateStatement } from "../../src/server/d1/protocol.ts";
import { deltaPlanSchema, type DeltaPlan, type DeltaChange } from "./delta.ts";
import { ALL_TABLES, APP_TABLES, TABLES, keyColumn, normalizeRow, quote, rawRowSchema } from "./format.ts";

export interface DeltaApplyProof {
  preCutoverOnly: true;
  sourceWritersFenced: true;
  d1ApplicationWritesNeverEnabled: true;
  baselineFullyVerified: true;
  expectedDeltaSha256: string;
  expectedBaseSnapshotId: string;
  expectedFinalSnapshotId: string;
  expectedSourceIdentitySha256: string;
}
interface Predicate {
  sql: string;
  params: D1Value[];
}
const guardNames = ["WatchedSection_reserve_paidId_insert", "WatchedSection_reserve_paidId_update"];
const booleanResult = z.array(z.object({ matches: z.union([z.literal(0), z.literal(1)]) })).length(1);

export function hashDeltaPlan(plan: DeltaPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(deltaPlanSchema.parse(plan)))
    .digest("hex");
}

function validatePlan(plan: DeltaPlan): DeltaPlan {
  const parsed = deltaPlanSchema.parse(plan);
  const keys = new Set<string>();
  for (const change of parsed.changes) {
    const identity = JSON.stringify([change.table, change.key]);
    if (keys.has(identity)) {
      throw new Error("Delta contains duplicate row transitions; values withheld");
    }
    keys.add(identity);
    for (const row of [change.before, change.after]) {
      if (row === null) {
        continue;
      }
      const object = rawRowSchema.parse(
        Object.fromEntries(TABLES[change.table].map((column, i) => [column.name, row[i]])),
      );
      if (JSON.stringify(normalizeRow(change.table, object)) !== JSON.stringify(row)) {
        throw new Error("Delta contains noncanonical storage values; values withheld");
      }
    }
  }
  for (const table of ALL_TABLES) {
    const count = parsed.changes
      .filter((change) => change.table === table)
      .reduce(
        (n, change) => n + (change.kind === "insert" ? 1 : change.kind === "delete" ? -1 : 0),
        parsed.base.tables[table].rows,
      );
    if (count !== parsed.final.tables[table].rows) {
      throw new Error("Delta table counts do not reconcile");
    }
  }
  if (parsed.base.snapshotId === parsed.final.snapshotId) {
    throw new Error("Delta snapshots must differ");
  }
  return parsed;
}

function statePredicates(plan: DeltaPlan, state: "before" | "after"): Predicate[] {
  const snapshot = state === "before" ? plan.base : plan.final;
  const predicates: Predicate[] = ALL_TABLES.map((table) => ({
    sql: `(SELECT count(*) FROM ${quote(table)}) = ?`,
    params: [snapshot.tables[table].rows],
  }));
  for (const change of plan.changes) {
    const row = change[state];
    predicates.push(
      row === null
        ? {
            sql: `NOT EXISTS (SELECT 1 FROM ${quote(change.table)} WHERE ${quote(keyColumn(change.table))} IS ?)`,
            params: [change.key],
          }
        : {
            sql: `EXISTS (SELECT 1 FROM ${quote(change.table)} WHERE ${TABLES[change.table].map((column) => `${quote(column.name)} IS ?`).join(" AND ")})`,
            params: row,
          },
    );
  }
  return predicates;
}

function packPredicates(predicates: Predicate[]): Predicate[] {
  const batches: Predicate[] = [];
  let batch: Predicate = { sql: "", params: [] };
  for (const predicate of predicates) {
    // One additional parameter is reserved for an invariant-row ID.
    if (batch.params.length + predicate.params.length > 99 || batch.sql.length + predicate.sql.length > 60_000) {
      if (!batch.sql) {
        throw new Error("Delta assertion exceeds statement limits");
      }
      batches.push(batch);
      batch = { sql: "", params: [] };
    }
    batch.sql += `${batch.sql ? " AND " : ""}(${predicate.sql})`;
    batch.params.push(...predicate.params);
  }
  if (batch.sql) {
    batches.push(batch);
  }
  return batches;
}

function guardPredicate(): Predicate {
  return {
    sql: `(SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${APP_TABLES.map(() => "?").join(",")})) = 2
      AND (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)) = 2`,
    params: [...APP_TABLES, ...guardNames],
  };
}

function integrityPredicates(): Predicate[] {
  return [
    { sql: "NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)", params: [] },
    {
      sql: 'NOT EXISTS (SELECT paidId FROM "WatchedSection" EXCEPT SELECT paidId FROM "PaymentReference")',
      params: [],
    },
    {
      sql: 'NOT EXISTS (SELECT paidId FROM "PaymentReference" EXCEPT SELECT paidId FROM "WatchedSection")',
      params: [],
    },
  ];
}

/** Reads only aggregate booleans; used after transport uncertainty, never to blindly retry. */
export async function verifyDeltaState(executor: D1Executor, input: DeltaPlan, state: "before" | "after") {
  const plan = validatePlan(input);
  const predicates = [
    guardPredicate(),
    { sql: 'NOT EXISTS (SELECT 1 FROM "D1Invariant")', params: [] },
    ...statePredicates(plan, state),
    ...integrityPredicates(),
  ];
  for (const predicate of packPredicates(predicates)) {
    const rows = booleanResult.parse(
      await executor.query(`SELECT CASE WHEN ${predicate.sql} THEN 1 ELSE 0 END AS matches`, predicate.params),
    );
    if (rows[0]!.matches !== 1) {
      return { matches: false, state, deltaSha256: hashDeltaPlan(plan) };
    }
  }
  return { matches: true, state, deltaSha256: hashDeltaPlan(plan) };
}

function mutation(change: DeltaChange): D1Statement {
  if (change.kind === "delete") {
    return {
      sql: `DELETE FROM ${quote(change.table)} WHERE ${quote(keyColumn(change.table))} = ?`,
      params: [change.key],
    };
  }
  if (!change.after) {
    throw new Error("Missing final row");
  }
  if (change.kind === "insert") {
    return {
      sql: `INSERT INTO ${quote(change.table)} (${TABLES[change.table].map((column) => quote(column.name)).join(",")}) VALUES (${change.after.map(() => "?").join(",")})`,
      params: change.after,
    };
  }
  // UPDATE in place is essential: replacing a ClassInfo row would SET NULL on
  // unchanged watch foreign keys through its ON DELETE action.
  return {
    sql: `UPDATE ${quote(change.table)} SET ${TABLES[change.table].map((column) => `${quote(column.name)} = ?`).join(",")} WHERE ${quote(keyColumn(change.table))} = ?`,
    params: [...change.after, change.key],
  };
}

export function buildDeltaBatch(input: DeltaPlan): D1Statement[] {
  const plan = validatePlan(input);
  const statements: D1Statement[] = [];
  const assertionIds: string[] = [];
  const addAssertions = (predicates: Predicate[]) => {
    for (const predicate of packPredicates(predicates)) {
      const id = randomUUID();
      assertionIds.push(id);
      statements.push({
        sql: `INSERT INTO "D1Invariant" (id, value) VALUES (?, CASE WHEN ${predicate.sql} THEN 1 ELSE 0 END)`,
        params: [id, ...predicate.params],
      });
    }
  };
  addAssertions([
    guardPredicate(),
    { sql: 'NOT EXISTS (SELECT 1 FROM "D1Invariant")', params: [] },
    ...statePredicates(plan, "before"),
  ]);
  // Ensure a legitimate ClassInfo deletion cannot silently change a watch that
  // is absent from the fully verified delta's changed-row set.
  const changedWatches = plan.changes.filter((change) => change.table === "WatchedSection").map((change) => change.key);
  addAssertions(
    plan.changes
      .filter((change) => change.table === "ClassInfo" && change.kind === "delete")
      .map((change) => ({
        sql: `NOT EXISTS (SELECT 1 FROM "WatchedSection" WHERE "classInfoId" = ? AND id NOT IN (SELECT value FROM json_each(?)))`,
        params: [change.key, JSON.stringify(changedWatches)],
      })),
  );
  statements.push({ sql: "PRAGMA defer_foreign_keys = ON" });
  for (const name of guardNames) {
    statements.push({ sql: `DROP TRIGGER ${quote(name)}` });
  }
  for (const table of [...ALL_TABLES].reverse()) {
    statements.push(
      ...plan.changes.filter((change) => change.table === table && change.kind === "delete").map(mutation),
    );
  }
  for (const table of ALL_TABLES) {
    statements.push(
      ...plan.changes.filter((change) => change.table === table && change.kind === "update").map(mutation),
    );
  }
  for (const table of ALL_TABLES) {
    statements.push(
      ...plan.changes.filter((change) => change.table === table && change.kind === "insert").map(mutation),
    );
  }
  const guards = readFileSync(
    new URL("../../prisma/d1/migrations/0002_payment_reference_guards.sql", import.meta.url),
    "utf8",
  ).match(/CREATE TRIGGER[\s\S]+?END;/g);
  if (guards?.length !== 2 || guardNames.some((name, i) => !guards[i]!.startsWith(`CREATE TRIGGER "${name}"`))) {
    throw new Error("Payment-reference trigger schema changed; manual review required");
  }
  statements.push(...guards.map((sql) => ({ sql })));
  addAssertions([...statePredicates(plan, "after"), guardPredicate(), ...integrityPredicates()]);
  for (let offset = 0; offset < assertionIds.length; offset += 100) {
    const ids = assertionIds.slice(offset, offset + 100);
    statements.push({ sql: `DELETE FROM "D1Invariant" WHERE id IN (${ids.map(() => "?").join(",")})`, params: ids });
  }
  if (statements.length > MAX_BATCH_STATEMENTS) {
    throw new Error("Delta exceeds the single native batch limit; no writes attempted");
  }
  const validated = statements.map(validateStatement);
  if (Buffer.byteLength(JSON.stringify({ version: 1, statements: validated }), "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("Delta exceeds gateway request limit; no writes attempted");
  }
  return validated;
}

/** Operator-only API: the executor must already be pinned to the verified destination. */
export async function applyDelta(executor: D1Executor, input: DeltaPlan, proof: DeltaApplyProof) {
  const plan = validatePlan(input);
  const deltaSha256 = hashDeltaPlan(plan);
  if (
    proof.preCutoverOnly !== true ||
    proof.sourceWritersFenced !== true ||
    proof.d1ApplicationWritesNeverEnabled !== true ||
    proof.baselineFullyVerified !== true ||
    proof.expectedDeltaSha256 !== deltaSha256 ||
    proof.expectedBaseSnapshotId !== plan.base.snapshotId ||
    proof.expectedFinalSnapshotId !== plan.final.snapshotId ||
    proof.expectedSourceIdentitySha256 !== plan.sourceIdentitySha256
  ) {
    throw new Error("Explicit matching pre-cutover proof required; no writes attempted");
  }
  const statements = buildDeltaBatch(plan); // Complete validation before the first remote call.
  const receipt = {
    deltaId: plan.deltaId,
    deltaSha256,
    baseSnapshotId: plan.base.snapshotId,
    finalSnapshotId: plan.final.snapshotId,
    changes: plan.changes.length,
    statements: statements.length,
    finalCounts: Object.fromEntries(ALL_TABLES.map((table) => [table, plan.final.tables[table].rows])),
  };
  try {
    const results = await executor.batch(statements);
    if (results.length !== statements.length) {
      throw new Error("Unexpected native batch receipt length");
    }
    return { ...receipt, outcome: "applied" as const, verifiedAt: new Date().toISOString() };
  } catch {
    // Never retry a possibly committed batch. Reconcile by reading both guarded
    // states; if neither can be confirmed, the operator must keep writers paused.
    try {
      if ((await verifyDeltaState(executor, plan, "after")).matches) {
        return { ...receipt, outcome: "after_state_verified" as const, verifiedAt: new Date().toISOString() };
      }
      if ((await verifyDeltaState(executor, plan, "before")).matches) {
        return { ...receipt, outcome: "not_applied" as const, verifiedAt: new Date().toISOString() };
      }
    } catch {
      /* An unavailable read leaves the write outcome unknown. */
    }
    return { ...receipt, outcome: "unknown" as const, verifiedAt: new Date().toISOString() };
  }
}
