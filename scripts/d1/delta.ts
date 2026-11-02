import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { hashFile, loadArtifact, manifestSchema, rehearsalSchema, writePrivate, type Manifest } from "./artifact.ts";
import {
  ALL_TABLES,
  TABLES,
  keyColumn,
  normalizeRow,
  quote,
  rawRowSchema,
  TableDigest,
  type Cell,
  type Table,
} from "./format.ts";
import { invalidTypesSql } from "./verify.ts";

const cellSchema = z.union([z.string(), z.number().int().safe(), z.null()]);
const tableSchema = z.enum(["Student", "ClassInfo", "WatchedSection", "NotificationSent", "PaymentReference"]);
const changeSchema = z
  .object({
    table: tableSchema,
    key: z.string(),
    kind: z.enum(["insert", "update", "delete"]),
    before: z.array(cellSchema).nullable(),
    after: z.array(cellSchema).nullable(),
  })
  .superRefine((change, context) => {
    const validChange =
      change.kind === "insert"
        ? change.before === null && change.after !== null
        : change.kind === "delete"
          ? change.before !== null && change.after === null
          : change.before !== null && change.after !== null;
    if (!validChange) {
      context.addIssue({ code: "custom", message: "Invalid delta before/after shape" });
    }
    for (const row of [change.before, change.after]) {
      if (row === null) {
        continue;
      }
      if (
        row.length !== TABLES[change.table].length ||
        row[TABLES[change.table].findIndex((column) => column.name === keyColumn(change.table))] !== change.key
      ) {
        context.addIssue({ code: "custom", message: "Invalid delta key/column shape" });
      }
    }
  });
const snapshotSchema = z
  .object({
    snapshotId: z.uuid(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .and(manifestSchema.pick({ tables: true }));
export const deltaPlanSchema = z.object({
  version: z.literal(1),
  deltaId: z.uuid(),
  createdAt: z.iso.datetime(),
  preCutoverOnly: z.literal(true),
  sourceIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  base: snapshotSchema,
  final: snapshotSchema,
  referencePolicy: z.literal("exact-final-distinct-before-first-D1-write"),
  changes: z.array(changeSchema).max(100),
  validation: z.object({
    baseDigestsVerified: z.literal(true),
    finalDigestsVerified: z.literal(true),
    foreignKeyViolations: z.literal(0),
    invalidStorageTypes: z.literal(0),
  }),
});
export type DeltaPlan = z.infer<typeof deltaPlanSchema>;
export type DeltaChange = z.infer<typeof changeSchema>;

function* canonicalRows(db: DatabaseSync, table: Table, digest: TableDigest): Generator<Cell[]> {
  const sql = `SELECT ${TABLES[table].map((column) => quote(column.name)).join(",")} FROM ${quote(table)} ORDER BY ${quote(keyColumn(table))} COLLATE BINARY`;
  for (const record of db.prepare(sql).iterate()) {
    const row = normalizeRow(table, rawRowSchema.parse(record));
    digest.add(row);
    yield row;
  }
}
const rowKey = (table: Table, row: Cell[]): string =>
  z.string().parse(row[TABLES[table].findIndex((column) => column.name === keyColumn(table))]);

export function compareSnapshots(
  baseDb: DatabaseSync,
  finalDb: DatabaseSync,
  base: Manifest,
  final: Manifest,
  maximumChanges = 100,
): DeltaChange[] {
  z.number().int().min(0).max(100).parse(maximumChanges);
  for (const db of [baseDb, finalDb]) {
    if (Number(db.prepare("SELECT count(*) AS n FROM pragma_foreign_key_check").get()!.n) !== 0) {
      throw new Error("Snapshot foreign-key validation failed");
    }
    if (Number(db.prepare(`SELECT ${invalidTypesSql()} AS n`).get()!.n) !== 0) {
      throw new Error("Snapshot storage types failed");
    }
  }
  const changes: DeltaChange[] = [];
  const add = (change: DeltaChange) => {
    if (changes.length >= maximumChanges) {
      throw new Error(`Delta exceeds ${maximumChanges} changes; no partial plan may be applied`);
    }
    changes.push(change);
  };
  for (const table of ALL_TABLES) {
    const beforeDigest = new TableDigest(table);
    const afterDigest = new TableDigest(table);
    const beforeRows = canonicalRows(baseDb, table, beforeDigest);
    const afterRows = canonicalRows(finalDb, table, afterDigest);
    try {
      let before = beforeRows.next();
      let after = afterRows.next();
      while (!before.done || !after.done) {
        const comparison = before.done
          ? 1
          : after.done
            ? -1
            : Buffer.compare(Buffer.from(rowKey(table, before.value)), Buffer.from(rowKey(table, after.value)));
        if (comparison < 0 && !before.done) {
          add({ table, key: rowKey(table, before.value), kind: "delete", before: before.value, after: null });
          before = beforeRows.next();
        } else if (comparison > 0 && !after.done) {
          add({ table, key: rowKey(table, after.value), kind: "insert", before: null, after: after.value });
          after = afterRows.next();
        } else if (!before.done && !after.done) {
          if (JSON.stringify(before.value) !== JSON.stringify(after.value)) {
            add({ table, key: rowKey(table, before.value), kind: "update", before: before.value, after: after.value });
          }
          before = beforeRows.next();
          after = afterRows.next();
        }
      }
    } finally {
      beforeRows.return(undefined);
      afterRows.return(undefined);
    }
    if (
      JSON.stringify(beforeDigest.finish()) !== JSON.stringify(base.tables[table]) ||
      JSON.stringify(afterDigest.finish()) !== JSON.stringify(final.tables[table])
    ) {
      throw new Error(`Full snapshot digest mismatch for ${table}; no delta written`);
    }
  }
  return changes;
}

async function verifiedLocalSnapshot(path: string) {
  const artifact = await loadArtifact(path);
  const manifestSha256 = await hashFile(join(artifact.directory, "manifest.json"));
  const rehearsalPath = join(artifact.directory, "rehearsal.json");
  const rehearsalStat = await lstat(rehearsalPath);
  if (!rehearsalStat.isFile() || rehearsalStat.isSymbolicLink() || (rehearsalStat.mode & 0o077) !== 0) {
    throw new Error("Unsafe rehearsal marker");
  }
  const rehearsal = rehearsalSchema.parse(JSON.parse(await readFile(rehearsalPath, "utf8")));
  if (rehearsal.snapshotId !== artifact.manifest.snapshotId || rehearsal.manifestSha256 !== manifestSha256) {
    throw new Error("Rehearsal does not match snapshot");
  }
  const databasePath = join(artifact.directory, "rehearsal.sqlite");
  const stat = await lstat(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Unsafe local snapshot database");
  }
  return { ...artifact, manifestSha256, databasePath };
}
export async function prepareDelta(
  basePath: string,
  finalPath: string,
  maximumChanges = 100,
): Promise<{ path: string; plan: DeltaPlan }> {
  const base = await verifiedLocalSnapshot(basePath);
  const final = await verifiedLocalSnapshot(finalPath);
  const identity = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(base.manifest.source.identitySha256);
  if (final.manifest.source.identitySha256 !== identity || base.manifest.snapshotId === final.manifest.snapshotId) {
    throw new Error("Delta requires distinct snapshots of the same source");
  }
  const baseDb = new DatabaseSync(base.databasePath, { readOnly: true, enableForeignKeyConstraints: true });
  const finalDb = new DatabaseSync(final.databasePath, { readOnly: true, enableForeignKeyConstraints: true });
  try {
    const changes = compareSnapshots(baseDb, finalDb, base.manifest, final.manifest, maximumChanges);
    const plan = deltaPlanSchema.parse({
      version: 1,
      deltaId: randomUUID(),
      createdAt: new Date().toISOString(),
      preCutoverOnly: true,
      sourceIdentitySha256: identity,
      base: { snapshotId: base.manifest.snapshotId, manifestSha256: base.manifestSha256, tables: base.manifest.tables },
      final: {
        snapshotId: final.manifest.snapshotId,
        manifestSha256: final.manifestSha256,
        tables: final.manifest.tables,
      },
      referencePolicy: "exact-final-distinct-before-first-D1-write",
      changes,
      validation: {
        baseDigestsVerified: true,
        finalDigestsVerified: true,
        foreignKeyViolations: 0,
        invalidStorageTypes: 0,
      },
    });
    const path = join(final.directory, `delta-from-${base.manifest.snapshotId}.json`);
    await writePrivate(path, JSON.stringify(plan, null, 2) + "\n");
    return { path, plan };
  } finally {
    baseDb.close();
    finalDb.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { base: { type: "string" }, final: { type: "string" }, "max-changes": { type: "string", default: "100" } },
    strict: true,
  });
  Promise.resolve()
    .then(async () => {
      if (!values.base || !values.final) {
        throw new Error("--base and --final required");
      }
      const result = await prepareDelta(
        values.base,
        values.final,
        z.coerce.number().int().min(0).max(100).parse(values["max-changes"]),
      );
      console.log(
        JSON.stringify({
          ok: true,
          deltaPath: result.path,
          changes: result.plan.changes.length,
          byTable: Object.fromEntries(
            ALL_TABLES.map((table) => [table, result.plan.changes.filter((change) => change.table === table).length]),
          ),
          remoteWrites: false,
        }),
      );
    })
    .catch(() => {
      console.error(
        "Private delta preparation failed. No partial plan written, customer rows logged, or remote writes performed.",
      );
      process.exitCode = 1;
    });
}
