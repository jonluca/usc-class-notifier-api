import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_TABLES,
  APP_TABLES,
  TABLES,
  MAX_SQL_BYTES,
  MAX_VALUES,
  insertStatement,
  normalizeRow,
  TableDigest,
  type Cell,
  type Table,
  type RawRow,
} from "./format.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PRIVATE_ROOT = join(REPO, "scripts/d1/.private");
export const MIGRATIONS = [
  "prisma/d1/migrations/0001_schema.sql",
  "prisma/d1/migrations/0002_payment_reference_guards.sql",
];
export type Rows = (table: Table) => AsyncIterable<RawRow>;
export interface ArtifactFile {
  name: string;
  sha256: string;
  bytes: number;
  phase: "schema" | "data" | "guards";
}
const tableSummarySchema = z.object({
  rows: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  leadingZeroTextValues: z.number().int().nonnegative(),
  timestamps: z.record(
    z.string(),
    z.object({
      nonNull: z.number().int().nonnegative(),
      min: z.number().int().nullable(),
      max: z.number().int().nullable(),
    }),
  ),
});
export const manifestSchema = z.object({
  format: z.literal("usc-d1-snapshot-v1"),
  snapshotId: z.uuid(),
  createdAt: z.iso.datetime(),
  complete: z.literal(true),
  source: z.record(z.string(), z.string()),
  normalization: z.object({
    timestamp: z.literal("epoch-milliseconds-utc"),
    boolean: z.literal("integer-0-or-1"),
    order: z.literal("utf8-binary-primary-key"),
  }),
  files: z
    .array(
      z.object({
        name: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().nonnegative(),
        phase: z.enum(["schema", "data", "guards"]),
      }),
    )
    .min(2),
  tables: z.object({
    Student: tableSummarySchema,
    ClassInfo: tableSummarySchema,
    WatchedSection: tableSummarySchema,
    NotificationSent: tableSummarySchema,
    PaymentReference: tableSummarySchema,
  }),
});
export type Manifest = z.infer<typeof manifestSchema>;
export const rehearsalSchema = z.object({
  ok: z.literal(true),
  snapshotId: z.uuid(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function privateRoot(): Promise<void> {
  await mkdir(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
  const stat = await lstat(PRIVATE_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("Private artifact root must be a real mode0700 directory");
  }
}
export async function snapshotDirectory(name: string): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) {
    throw new Error("Use a simple new snapshot name, not a path");
  }
  await privateRoot();
  const directory = join(PRIVATE_ROOT, name);
  await mkdir(directory, { mode: 0o700 }); // No recursive/overwrite: existing snapshots are never reused.
  return directory;
}
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
export async function writePrivate(path: string, data: string): Promise<void> {
  await writeFile(path, data, { flag: "wx", mode: 0o600 });
}

export async function exportArtifact(
  directory: string,
  rows: Rows,
  source: Record<string, string>,
  migrations: string[] = MIGRATIONS.map((p) => join(REPO, p)),
): Promise<Manifest> {
  const manifest: Manifest = {
    format: "usc-d1-snapshot-v1",
    snapshotId: randomUUID(),
    createdAt: new Date().toISOString(),
    complete: true,
    source,
    normalization: { timestamp: "epoch-milliseconds-utc", boolean: "integer-0-or-1", order: "utf8-binary-primary-key" },
    files: [],
    tables: {
      Student: new TableDigest("Student").finish(),
      ClassInfo: new TableDigest("ClassInfo").finish(),
      WatchedSection: new TableDigest("WatchedSection").finish(),
      NotificationSent: new TableDigest("NotificationSent").finish(),
      PaymentReference: new TableDigest("PaymentReference").finish(),
    },
  };
  let sequence = 0;
  const copyMigration = async (path: string, phase: "schema" | "guards") => {
    const sql = await readFile(path, "utf8");
    const name = `${String(sequence++).padStart(4, "0")}-${phase}.sql`;
    await writePrivate(join(directory, name), sql);
    manifest.files.push({ name, bytes: Buffer.byteLength(sql), sha256: await hashFile(join(directory, name)), phase });
  };
  await copyMigration(migrations[0]!, "schema");
  for (const table of ALL_TABLES) {
    const digest = new TableDigest(table);
    let pending: Cell[][] = [];
    let output: Awaited<ReturnType<typeof open>> | undefined;
    let outputName = "";
    let outputBytes = 0;
    let outputHash = createHash("sha256");
    let bufferedSql: string[] = [];
    let bufferedBytes = 0;
    const flushWrites = async () => {
      if (!output || bufferedBytes === 0) {
        return;
      }
      await output.writeFile(bufferedSql.join(""));
      bufferedSql = [];
      bufferedBytes = 0;
    };
    const close = async () => {
      if (!output) {
        return;
      }
      await flushWrites();
      await output.close();
      output = undefined;
      manifest.files.push({ name: outputName, bytes: outputBytes, sha256: outputHash.digest("hex"), phase: "data" });
    };
    const flush = async () => {
      if (!pending.length) {
        return;
      }
      const sql = insertStatement(table, pending);
      if (output && outputBytes + Buffer.byteLength(sql) > 8 * 1024 * 1024) {
        await close();
      }
      if (!output) {
        outputName = `${String(sequence++).padStart(4, "0")}-${table}.sql`;
        output = await open(join(directory, outputName), "wx", 0o600);
        outputBytes = 0;
        outputHash = createHash("sha256");
      }
      bufferedSql.push(sql);
      bufferedBytes += Buffer.byteLength(sql);
      if (bufferedBytes >= 256 * 1024) {
        await flushWrites();
      }
      outputHash.update(sql);
      outputBytes += Buffer.byteLength(sql);
      pending = [];
    };
    try {
      for await (const record of rows(table)) {
        const row = normalizeRow(table, record);
        digest.add(row);
        if (APP_TABLES.includes(table)) {
          // Validate every single row first: never split a value or silently truncate a large record.
          const one = insertStatement(table, [row]);
          const tupleBytes = Buffer.byteLength(one);
          const pendingBytes = pending.length ? Buffer.byteLength(insertStatement(table, pending)) : 0;
          if ((pending.length + 1) * TABLES[table].length > MAX_VALUES || pendingBytes + tupleBytes > MAX_SQL_BYTES) {
            await flush();
          }
          pending.push(row);
        }
      }
      await flush();
      await close();
      manifest.tables[table] = digest.finish();
    } finally {
      await output?.close();
    }
  }
  await copyMigration(migrations[1]!, "guards");
  // This marker is only written after every source cursor and output file completes successfully.
  await writePrivate(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function loadArtifact(path: string): Promise<{ directory: string; manifest: Manifest }> {
  await privateRoot();
  const directory = await realpath(resolve(path));
  if (!directory.startsWith((await realpath(PRIVATE_ROOT)) + "/")) {
    throw new Error("Snapshot must be inside the ignored private artifact root");
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error("Snapshot directory permissions must be0700");
  }
  const manifestPath = join(directory, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o077) !== 0) {
    throw new Error("Unsafe manifest file");
  }
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (
    manifest.format !== "usc-d1-snapshot-v1" ||
    manifest.complete !== true ||
    !Array.isArray(manifest.files) ||
    !ALL_TABLES.every((t) => manifest.tables?.[t])
  ) {
    throw new Error("Incomplete or unsupported snapshot manifest");
  }
  const names = new Set<string>();
  for (const file of manifest.files) {
    if (file.name !== basename(file.name) || !/^\d{4,}-[A-Za-z]+\.sql$/.test(file.name) || names.has(file.name)) {
      throw new Error("Invalid or duplicate artifact filename");
    }
    names.add(file.name);
    const filePath = join(directory, file.name);
    const fileStat = await lstat(filePath);
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      (fileStat.mode & 0o077) !== 0 ||
      fileStat.size !== file.bytes ||
      (await hashFile(filePath)) !== file.sha256
    ) {
      throw new Error("Artifact file integrity or permissions failed");
    }
  }
  if (
    manifest.files[0]?.phase !== "schema" ||
    manifest.files.at(-1)?.phase !== "guards" ||
    manifest.files.slice(1, -1).some((f) => f.phase !== "data")
  ) {
    throw new Error("Unsafe import phase order");
  }
  return { directory, manifest };
}
