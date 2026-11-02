import { z } from "zod";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadArtifact } from "./artifact.ts";
import { TABLES, quote, keyColumn, rawRowSchema, type RawRow, type Table } from "./format.ts";
import { invalidTypesSql, verifyRows } from "./verify.ts";

export interface TargetIdentity {
  account: string;
  database: string;
  name: string;
}
export function validateIdentity(identity: TargetIdentity): void {
  if (
    !/^[a-f0-9]{32}$/i.test(identity.account) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(identity.database) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(identity.name)
  ) {
    throw new Error("Explicit valid account ID, database UUID, and database name required");
  }
}
export class D1Target {
  private base: string;
  private lastRequestAt = 0;
  constructor(
    readonly identity: TargetIdentity,
    private token: string,
    private request: typeof fetch = fetch,
    private timing = {
      now: () => Date.now(),
      wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
  ) {
    validateIdentity(identity);
    if (!token) {
      throw new Error("CLOUDFLARE_API_TOKEN is required");
    }
    this.base = `https://api.cloudflare.com/client/v4/accounts/${identity.account}/d1/database/${identity.database}`;
  }
  private async api<T>(
    schema: z.ZodType<T>,
    path: string,
    sql?: string,
    params?: (string | number | null)[],
  ): Promise<T> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const throttle = Math.max(0, this.lastRequestAt + 300 - this.timing.now());
      if (throttle) {
        await this.timing.wait(throttle);
      }
      this.lastRequestAt = this.timing.now();
      try {
        response = await this.request(this.base + path, {
          method: sql ? "POST" : "GET",
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          body: sql ? JSON.stringify({ sql, params: params ?? [] }) : undefined,
          signal: AbortSignal.timeout(35_000),
          redirect: "error",
        });
      } catch {
        if (attempt === 3) {
          throw new Error("D1 read transport retries exhausted; details withheld");
        }
        await this.timing.wait(1000 * 2 ** attempt);
        continue;
      }
      if (![429, 502, 503, 504].includes(response.status) || attempt === 3) {
        break;
      }
      const retryAfter = response.headers.get("Retry-After");
      const requestedDelay =
        retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : retryAfter
            ? Date.parse(retryAfter) - this.timing.now()
            : 0;
      const delay = Math.max(1000 * 2 ** attempt, Number.isFinite(requestedDelay) ? requestedDelay : 0);
      await response.body?.cancel();
      if (delay > 60_000) {
        throw new Error("D1 requested a longer cooldown; stop and retry the read-only verification later");
      }
      await this.timing.wait(delay);
    }
    if (!response) {
      throw new Error("Missing D1 read response");
    }
    if (!response.ok) {
      throw new Error(`D1 request failed with HTTP ${response.status}; response withheld`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Missing D1 response");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > 20 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("D1 response bound exceeded");
      }
      chunks.push(value);
    }
    const body = z
      .object({ success: z.literal(true), result: schema })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (body.success !== true) {
      throw new Error("D1 API operation failed; details withheld");
    }
    return body.result;
  }
  async confirmIdentity(): Promise<void> {
    const result = await this.api(z.object({ uuid: z.string(), name: z.string() }), "");
    if (result.uuid !== this.identity.database || result.name !== this.identity.name) {
      throw new Error("D1 target identity mismatch");
    }
  }
  async query(sql: string, params: (string | number | null)[] = []): Promise<RawRow[]> {
    // This helper is deliberately read-only. There is no generic execution/import mode.
    if (!/^SELECT\s/i.test(sql) || sql.includes(";")) {
      throw new Error("Only SELECT queries are allowed");
    }
    const result = await this.api(
      z.array(z.object({ success: z.boolean().optional(), results: z.array(rawRowSchema) })),
      "/query",
      sql,
      params,
    );
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      result[0]?.success === false ||
      !Array.isArray(result[0]?.results)
    ) {
      throw new Error("Unexpected D1 query response");
    }
    return result[0].results;
  }
  async assertEmpty(): Promise<void> {
    await this.confirmIdentity();
    const tables = await this.query("SELECT name FROM sqlite_master WHERE type='table'");
    const allowedInternal = new Set(["_cf_KV", "sqlite_sequence"]);
    if (tables.some((row) => !z.string().safeParse(row.name).success || !allowedInternal.has(String(row.name)))) {
      throw new Error("D1 target is not empty; replacement/overwrite is refused");
    }
  }
  async *rows(table: Table): AsyncIterable<RawRow> {
    let after: string | undefined;
    const key = keyColumn(table);
    while (true) {
      const page = await this.query(
        `SELECT ${TABLES[table].map((c) => quote(c.name)).join(",")} FROM ${quote(table)}${after === undefined ? "" : ` WHERE ${quote(key)} COLLATE BINARY > ?`} ORDER BY ${quote(key)} COLLATE BINARY LIMIT 5000`,
        after === undefined ? [] : [after],
      );
      if (!page.length) {
        break;
      }
      yield* page;
      const next = z.string().parse(page.at(-1)?.[key]);
      if (after !== undefined && Buffer.compare(Buffer.from(next), Buffer.from(after)) <= 0) {
        throw new Error("D1 verification cursor did not advance");
      }
      after = next;
    }
  }
}
export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      account: { type: "string" },
      database: { type: "string" },
      name: { type: "string" },
      empty: { type: "boolean" },
      verify: { type: "boolean" },
    },
    strict: true,
  });
  if (
    !values.snapshot ||
    !values.account ||
    !values.database ||
    !values.name ||
    Boolean(values.empty) === Boolean(values.verify)
  ) {
    throw new Error("Require snapshot, account, database, name and exactly one of --empty/--verify");
  }
  const { manifest } = await loadArtifact(values.snapshot);
  const target = new D1Target(
    { account: values.account, database: values.database, name: values.name },
    process.env.CLOUDFLARE_API_TOKEN ?? "",
  );
  if (values.empty) {
    await target.assertEmpty();
    console.log(JSON.stringify({ ok: true, empty: true, snapshotId: manifest.snapshotId, database: values.database }));
    return;
  }
  await target.confirmIdentity();
  if (Number((await target.query("SELECT count(*) AS n FROM pragma_foreign_key_check"))[0]?.n) !== 0) {
    throw new Error("Foreign-key check failed");
  }
  if (Number((await target.query(`SELECT ${invalidTypesSql()} AS n`))[0]?.n) !== 0) {
    throw new Error("Storage-type verification failed");
  }
  const triggers = await target.query(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('WatchedSection_reserve_paidId_insert','WatchedSection_reserve_paidId_update')",
  );
  if (triggers.length !== 2) {
    throw new Error("Payment-reference guards missing");
  }
  if (Number((await target.query('SELECT count(*) AS n FROM "D1Invariant"'))[0]?.n) !== 0) {
    throw new Error("Unexpected invariant rows before cutover");
  }
  const counts = await verifyRows(manifest, target.rows.bind(target));
  console.log(
    JSON.stringify({
      ok: true,
      verified: true,
      snapshotId: manifest.snapshotId,
      database: values.database,
      rows: counts,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("D1 read-only target check failed. No row values, API response bodies or credentials logged.");
    process.exitCode = 1;
  });
}
