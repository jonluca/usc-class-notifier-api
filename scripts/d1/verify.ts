import { DatabaseSync } from "node:sqlite";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadArtifact, hashFile, writePrivate, type Manifest, type Rows } from "./artifact.ts";
import { ALL_TABLES, TABLES, quote, keyColumn, normalizeRow, TableDigest, rawRowSchema } from "./format.ts";

export const invalidTypesSql = (): string =>
  ALL_TABLES.map((table) => {
    const predicates = TABLES[table].map((column) => {
      const c = quote(column.name);
      const expected = column.kind === "text" ? "text" : "integer";
      const invalid = `(typeof(${c}) <> '${expected}'${column.kind === "boolean" ? ` OR ${c} NOT IN (0,1)` : ""})`;
      return column.nullable ? `(${c} IS NOT NULL AND ${invalid})` : invalid;
    });
    return `(SELECT count(*) FROM ${quote(table)} WHERE ${predicates.join(" OR ")})`;
  }).join("+");

export async function verifyRows(manifest: Manifest, rows: Rows): Promise<Record<string, number>> {
  const verified: Record<string, number> = {};
  for (const table of ALL_TABLES) {
    const digest = new TableDigest(table);
    for await (const row of rows(table)) {
      digest.add(normalizeRow(table, row));
    }
    if (JSON.stringify(digest.finish()) !== JSON.stringify(manifest.tables[table])) {
      throw new Error(`Snapshot comparison failed for ${table}; row contents withheld`);
    }
    verified[table] = manifest.tables[table].rows;
  }
  return verified;
}

export async function rehearse(snapshotPath: string): Promise<Record<string, number>> {
  const { directory, manifest } = await loadArtifact(snapshotPath);
  const path = join(directory, "rehearsal.sqlite");
  const handle = await open(path, "wx", 0o600); // Refuse replacement, even if a previous rehearsal failed.
  await handle.close();
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA journal_mode=MEMORY; PRAGMA temp_store=MEMORY; BEGIN IMMEDIATE;");
    for (const file of manifest.files) {
      if (file.phase === "data") {
        const lines = createInterface({ input: createReadStream(join(directory, file.name)), crlfDelay: Infinity });
        for await (const line of lines) {
          if (line.trim()) {
            db.exec(line);
          }
        }
      } else {
        db.exec(await readFile(join(directory, file.name), "utf8"));
      }
    }
    if (Number(db.prepare("SELECT count(*) AS n FROM pragma_foreign_key_check").get()!.n) !== 0) {
      throw new Error("Foreign-key violations");
    }
    if (Number(db.prepare(`SELECT ${invalidTypesSql()} AS n`).get()!.n) !== 0) {
      throw new Error("Invalid SQLite storage types");
    }
    const rows: Rows = async function* (table) {
      const sql = `SELECT ${TABLES[table].map((c) => quote(c.name)).join(",")} FROM ${quote(table)} ORDER BY ${quote(keyColumn(table))} COLLATE BINARY`;
      for (const row of db.prepare(sql).iterate()) {
        yield rawRowSchema.parse(row);
      }
    };
    const result = await verifyRows(manifest, rows);
    db.exec("COMMIT;");
    await writePrivate(
      join(directory, "rehearsal.json"),
      JSON.stringify(
        {
          ok: true,
          snapshotId: manifest.snapshotId,
          manifestSha256: await hashFile(join(directory, "manifest.json")),
          verifiedAt: new Date().toISOString(),
          rows: result,
          foreignKeyViolations: 0,
          invalidTypes: 0,
        },
        null,
        2,
      ) + "\n",
    );
    return result;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { snapshot: { type: "string" } }, strict: true });
  Promise.resolve()
    .then(() => {
      if (!values.snapshot) {
        throw new Error("--snapshot required");
      }
      return rehearse(values.snapshot);
    })
    .then((rows) => console.log(JSON.stringify({ ok: true, localRehearsal: true, rows })))
    .catch(() => {
      console.error(
        "Local rehearsal failed. No customer data logged; retain the private artifact for controlled investigation.",
      );
      process.exitCode = 1;
    });
}
