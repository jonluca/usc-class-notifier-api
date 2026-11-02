import "dotenv/config";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { getPrismaCliDatabaseUrl } from "../../src/server/postgresConfig.ts";
import { exportArtifact, snapshotDirectory } from "./artifact.ts";
import { APP_TABLES, TABLES, keyColumn, quote, type RawRow, type Table } from "./format.ts";

export function sourceSelect(table: Table): string {
  if (table === "PaymentReference") {
    return `SELECT DISTINCT "paidId" COLLATE "C" AS "paidId" FROM "public"."WatchedSection" ORDER BY "paidId" COLLATE "C"`;
  }
  const columns = TABLES[table].map((column) =>
    column.kind === "timestamp"
      ? `(EXTRACT(EPOCH FROM ${quote(column.name)}) * 1000)::text AS ${quote(column.name)}`
      : quote(column.name),
  );
  return `SELECT ${columns.join(",")} FROM "public".${quote(table)} ORDER BY ${quote(keyColumn(table))} COLLATE "C"`;
}
export async function validatePostgresSchema(client: Client): Promise<void> {
  const { rows } = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    datetime_precision: number | null;
  }>(
    `SELECT table_name,column_name,data_type,datetime_precision FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])`,
    [APP_TABLES],
  );
  for (const table of APP_TABLES) {
    const actual = rows.filter((row) => row.table_name === table);
    if (actual.length !== TABLES[table].length) {
      throw new Error(`Source schema mismatch for ${table}`);
    }
    for (const column of TABLES[table]) {
      const field = actual.find((row) => row.column_name === column.name);
      const allowed =
        column.kind === "text"
          ? ["text", "character varying"]
          : column.kind === "timestamp"
            ? ["timestamp without time zone", "timestamp with time zone"]
            : column.kind === "boolean"
              ? ["boolean"]
              : ["integer", "smallint"];
      if (
        !field ||
        !allowed.includes(field.data_type) ||
        (column.kind === "timestamp" && (field.datetime_precision ?? 6) > 3)
      ) {
        throw new Error(`Source type/precision mismatch at ${table}.${column.name}`);
      }
    }
  }
}
export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { name: { type: "string" }, "expect-database": { type: "string" }, "expect-host": { type: "string" } },
    strict: true,
  });
  if (!values.name || !values["expect-database"] || !values["expect-host"]) {
    throw new Error("Required: --name --expect-database --expect-host");
  }
  const connectionString = getPrismaCliDatabaseUrl(process.env);
  if (!connectionString) {
    throw new Error("POSTGRES_URL_NON_POOLING or POSTGRES_PRISMA_URL is required");
  }
  const url = new URL(connectionString);
  if (
    decodeURIComponent(url.pathname.slice(1)) !== values["expect-database"] ||
    url.hostname !== values["expect-host"]
  ) {
    throw new Error("Postgres source identity mismatch");
  }
  const directory = await snapshotDirectory(values.name);
  const client = new Client({
    connectionString,
    application_name: "usc-d1-readonly-export",
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
  });
  // Keep driver connection errors out of stderr; pending queries still reject through the redacted CLI handler.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '120s'");
    const {
      rows: [identity],
    } = await client.query<{ database_name: string; snapshot: string; captured_at: string; encoding: string }>(
      "SELECT current_database() AS database_name,pg_current_snapshot()::text AS snapshot,current_timestamp::text AS captured_at,current_setting('server_encoding') AS encoding",
    );
    if (identity?.database_name !== values["expect-database"] || identity.encoding !== "UTF8") {
      throw new Error("Connected Postgres database mismatch");
    }
    await validatePostgresSchema(client);
    const source = {
      identitySha256: createHash("sha256")
        .update(`${url.hostname}\n${url.port || "5432"}\n${identity.database_name}`)
        .digest("hex"),
      postgresSnapshot: identity.snapshot,
      capturedAt: identity.captured_at,
      transaction: "REPEATABLE READ READ ONLY",
    };
    const rows = async function* (table: Table): AsyncIterable<RawRow> {
      await client.query(`DECLARE d1_export_cursor NO SCROLL CURSOR FOR ${sourceSelect(table)}`);
      try {
        while (true) {
          const page = await client.query<RawRow>("FETCH FORWARD 5000 FROM d1_export_cursor");
          if (!page.rows.length) {
            break;
          }
          yield* page.rows;
        }
      } finally {
        await client.query("CLOSE d1_export_cursor");
      }
    };
    const manifest = await exportArtifact(directory, rows, source);
    await client.query("ROLLBACK");
    console.log(
      JSON.stringify({
        ok: true,
        snapshot: values.name,
        snapshotId: manifest.snapshotId,
        rows: Object.fromEntries(Object.entries(manifest.tables).map(([table, summary]) => [table, summary.rows])),
      }),
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      "Read-only export failed. No source data or credentials logged; incomplete snapshots must not be imported.",
    );
    process.exitCode = 1;
  });
}
