import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { installSourceFence, sourceFenceStatus } from "./fence";

const socket = process.env.D1_FENCE_TEST_SOCKET;

test(
  "Postgres fence waits for writers, rejects active claims, and blocks all four tables atomically",
  { skip: !socket, timeout: 15_000 },
  async (context) => {
    assert.ok(socket?.startsWith("/") && socket.endsWith("/pg-sock"), "private local Unix socket required");
    const settings = { host: socket, port: 54587, database: "usc_d1_test", connectionTimeoutMillis: 2000 };
    const client = new Client(settings);
    const writer = new Client(settings);
    await client.connect();
    await writer.connect();
    await writer.query("SET TIME ZONE 'UTC'");
    let createdFixture = false;
    context.after(async () => {
      try {
        await writer.query("ROLLBACK");
        if (createdFixture) {
          await client.query(
            'DROP TABLE "NotificationSent", "WatchedSection", "ClassInfo", "Student"; DROP FUNCTION IF EXISTS usc_d1_cutover_reject_write()',
          );
        }
      } finally {
        await writer.end();
        await client.end();
      }
    });
    assert.equal((await client.query("SELECT current_database() AS name")).rows[0].name, "usc_d1_test");
    await client.query(
      'CREATE TABLE "Student" (id text PRIMARY KEY); CREATE TABLE "ClassInfo" (id text PRIMARY KEY); CREATE TABLE "NotificationSent" (id text PRIMARY KEY); CREATE TABLE "WatchedSection" (id text PRIMARY KEY, "notificationClaimToken" text, "notificationClaimUntil" timestamp(3))',
    );
    createdFixture = true;
    await assert.rejects(installSourceFence(client, "wrong_database"), /identity mismatch/);
    await writer.query(
      "BEGIN; INSERT INTO \"WatchedSection\" VALUES ('local', 'active', CURRENT_TIMESTAMP + interval '1 minute')",
    );
    const pending = installSourceFence(client, "usc_d1_test");
    await writer.query("COMMIT");
    await assert.rejects(pending, /Active notification claims/);
    assert.deepEqual(await sourceFenceStatus(client), { fenced: false, tableCount: 0 });
    await client.query('UPDATE "WatchedSection" SET "notificationClaimToken" = NULL');
    assert.equal((await installSourceFence(client, "usc_d1_test")).installed, true);
    for (const table of ["Student", "ClassInfo", "WatchedSection", "NotificationSent"]) {
      await assert.rejects(client.query(`UPDATE "${table}" SET id = id WHERE false`), { code: "55000" });
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows.length, 1);
    }
    assert.equal((await installSourceFence(client, "usc_d1_test")).alreadyFenced, true);
  },
);
