import type { Client } from "pg";

const TABLES = ["Student", "ClassInfo", "WatchedSection", "NotificationSent"] as const;
const FUNCTION = "usc_d1_cutover_reject_write";
const TRIGGER = "usc_d1_cutover_write_fence";

export async function sourceFenceStatus(client: Client) {
  const result = await client.query<{ table_name: string; enabled: string }>(
    `SELECT c.relname AS table_name, t.tgenabled AS enabled
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'public' AND t.tgname = $1 AND p.proname = $2
     ORDER BY c.relname`,
    [TRIGGER, FUNCTION],
  );
  const fenced =
    result.rows.length === TABLES.length &&
    TABLES.every((table) => result.rows.some((row) => row.table_name === table && row.enabled === "A"));
  return { fenced, tableCount: result.rows.length };
}

/** Install only after web maintenance and scheduler drain; source data is never modified. */
export async function installSourceFence(client: Client, expectedDatabase: string) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const identity = await client.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== expectedDatabase) {
      throw new Error("Source database identity mismatch");
    }
    // Taking all four locks before testing claims closes the old-deployment race:
    // no writer can obtain a new notification claim between this check and commit.
    await client.query(
      `LOCK TABLE ${TABLES.map((table) => `public."${table}"`).join(", ")} IN SHARE ROW EXCLUSIVE MODE`,
    );
    const current = await sourceFenceStatus(client);
    if (current.fenced) {
      await client.query("ROLLBACK");
      return { installed: false, alreadyFenced: true, tables: TABLES.length };
    }
    const conflicts = await client.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1)
       + (SELECT count(*) FROM pg_trigger WHERE tgname = $2))::int AS n`,
      [FUNCTION, TRIGGER],
    );
    if (conflicts.rows[0]?.n !== 0) {
      throw new Error("Existing or partial fence objects require inspection");
    }
    const claims = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public."WatchedSection"
       WHERE "notificationClaimToken" IS NOT NULL AND "notificationClaimUntil" > CURRENT_TIMESTAMP`,
    );
    if (claims.rows[0]?.n !== 0) {
      throw new Error("Active notification claims must drain before fencing");
    }
    await client.query(`CREATE FUNCTION public.${FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'USC PostgreSQL writes are disabled for D1 cutover' USING ERRCODE = '55000'; END;
      $body$`);
    for (const table of TABLES) {
      await client.query(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public."${table}"
        FOR EACH STATEMENT EXECUTE FUNCTION public.${FUNCTION}()`);
      await client.query(`ALTER TABLE public."${table}" ENABLE ALWAYS TRIGGER ${TRIGGER}`);
    }
    if (!(await sourceFenceStatus(client)).fenced) {
      throw new Error("Source fence verification failed");
    }
    await client.query("COMMIT");
    return { installed: true, alreadyFenced: false, tables: TABLES.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
