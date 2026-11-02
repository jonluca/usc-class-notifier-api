import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { exportArtifact, loadArtifact, snapshotDirectory, hashFile, type Rows } from "./artifact.ts";
import {
  TABLES,
  normalizeRow,
  insertStatement,
  TableDigest,
  MAX_SQL_BYTES,
  quote,
  keyColumn,
  rawRowSchema,
  type RawRow,
  type Table,
} from "./format.ts";
import { sourceSelect } from "./export.ts";
import { rehearse, verifyRows } from "./verify.ts";
import { D1Target } from "./target.ts";
import { prepareImport } from "./import-plan.ts";
import { prepareDelta } from "./delta.ts";

const directories: string[] = [];
after(async () => {
  for (const path of directories) {
    await rm(path, { recursive: true, force: true });
  }
});
const newDirectory = async () => {
  const path = await snapshotDirectory(`synthetic-${randomUUID()}`);
  directories.push(path);
  return path;
};
const record = (table: Table, overrides: RawRow): RawRow =>
  rawRowSchema.parse(
    Object.fromEntries(
      TABLES[table].map((c) => [
        c.name,
        c.name in overrides
          ? overrides[c.name]
          : c.nullable
            ? null
            : c.kind === "text"
              ? `${table}-${c.name}`
              : c.kind === "boolean"
                ? false
                : 0,
      ]),
    ),
  );
function fixture() {
  const tables = {
    Student: [
      record("Student", {
        id: "s01",
        createdAt: "1793574000123.000",
        email: "synthetic@example.invalid",
        verificationKey: "not-a-real-key",
        uscID: "0012345678",
      }),
    ],
    ClassInfo: [
      record("ClassInfo", {
        id: "c01",
        semester: "20271",
        section: "00001",
        courseTitle: "Synthetic 'quote'\nUnicode 🚀 ; DROP TABLE Student; --",
      }),
    ],
    WatchedSection: ["20261", "20271"].map((semester, index) =>
      record("WatchedSection", {
        id: `w0${index + 1}`,
        semester,
        section: "00001",
        paidId: "00123456",
        studentId: "s01",
        classInfoId: "c01",
        createdAt: "0.000",
        lastNotified: "-1.000",
        notified: true,
      }),
    ),
    NotificationSent: [record("NotificationSent", { id: "n01", sectionId: "w01", studentId: "s01" })],
    PaymentReference: [{ paidId: "00123456" }],
  } satisfies Record<Table, RawRow[]>;
  const rows: Rows = async function* (table) {
    yield* tables[table];
  };
  return { tables, rows };
}

test("synthetic snapshot rehearses exact IDs/nulls/epoch-ms/leading zeros and seeds legacy references before guards", async () => {
  const directory = await newDirectory();
  const { rows } = fixture();
  const manifest = await exportArtifact(directory, rows, { synthetic: "true" });
  assert.deepEqual(await rehearse(directory), {
    Student: 1,
    ClassInfo: 1,
    WatchedSection: 2,
    NotificationSent: 1,
    PaymentReference: 1,
  });
  assert.equal(manifest.tables.Student.timestamps.createdAt!.min, 1793574000123);
  assert.equal(manifest.tables.WatchedSection.timestamps.lastNotified!.min, -1);
  assert.ok(manifest.tables.WatchedSection.leadingZeroTextValues >= 4);
  assert.equal((await stat(directory)).mode & 0o077, 0);
  for (const file of manifest.files) {
    assert.equal((await stat(join(directory, file.name))).mode & 0o077, 0);
    if (file.phase === "data") {
      for (const line of (await readFile(join(directory, file.name), "utf8")).trim().split("\n")) {
        assert.ok(Buffer.byteLength(line) < MAX_SQL_BYTES);
      }
    }
  }
  const db = new DatabaseSync(join(directory, "rehearsal.sqlite"));
  try {
    const row = db.prepare('SELECT "createdAt","uscID",typeof("createdAt") AS t FROM "Student"').get()!;
    assert.equal(row.createdAt, 1793574000123);
    assert.equal(row.uscID, "0012345678");
    assert.equal(row.t, "integer");
    assert.throws(
      () =>
        db.exec(
          `INSERT INTO "WatchedSection" (id,section,semester,paidId,studentId) VALUES ('w03','00003','20281','00123456','s01')`,
        ),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        db.exec(
          `UPDATE "WatchedSection" SET paidId='00123456' || '' || '7' WHERE id='w01'; UPDATE "WatchedSection" SET paidId='001234567' WHERE id='w02'`,
        ),
      /UNIQUE/,
    );
    // The first successful change reserves the reference forever, independent of row lifetime.
    assert.equal(db.prepare('SELECT count(*) AS n FROM "PaymentReference"').get()!.n, 2);
  } finally {
    db.close();
  }
});

test("canonical normalization is timezone independent and refuses precision loss or malformed booleans", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Honolulu";
    const row = record("Student", { id: "x", createdAt: "1793574000123.000", validAccount: true });
    assert.equal(normalizeRow("Student", row)[1], 1793574000123);
    assert.equal(normalizeRow("Student", row)[6], 1);
    assert.match(sourceSelect("Student"), /EXTRACT\(EPOCH FROM "createdAt"\)/);
    assert.throws(() => normalizeRow("Student", { ...row, createdAt: "1793574000123.456" }), /value withheld/);
    assert.throws(() => normalizeRow("Student", { ...row, validAccount: "true" }), /value withheld/);
    assert.throws(() => normalizeRow("Student", { ...row, email: "bad\u0000value" }), /value withheld/);
  } finally {
    if (original === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = original;
    }
  }
});

test("digest detects ordering/field changes and SQL encoding preserves special text safely", () => {
  const digest = new TableDigest("PaymentReference");
  digest.add(["0001"]);
  assert.throws(() => digest.add(["0001"]), /unordered/);
  const row = normalizeRow("ClassInfo", fixture().tables.ClassInfo[0]!);
  const sql = insertStatement("ClassInfo", [row]);
  assert.ok(!sql.includes("DROP TABLE"));
  assert.equal(sql.split("\n").length, 2);
  const huge = record("Student", { id: "x", email: "synthetic".repeat(10_000) });
  assert.throws(() => insertStatement("Student", [normalizeRow("Student", huge)]), /contents withheld/);
});

test("rehearsal fails on broken foreign keys and partial snapshots never get complete markers", async () => {
  const directory = await newDirectory();
  const { tables, rows } = fixture();
  tables.NotificationSent[0]!.studentId = "absent-synthetic-id";
  await exportArtifact(directory, rows, { synthetic: "true" });
  await assert.rejects(rehearse(directory), /FOREIGN KEY/);
  const partial = await newDirectory();
  await assert.rejects(
    exportArtifact(
      partial,
      async function* () {
        yield fixture().tables.Student[0]!;
        throw new Error("synthetic source failure");
      },
      { synthetic: "true" },
    ),
  );
  await assert.rejects(readFile(join(partial, "manifest.json")), { code: "ENOENT" });
});

test("artifact hashes and exact comparison catch data changes; existing snapshots cannot be overwritten", async () => {
  const directory = await newDirectory();
  const { rows } = fixture();
  const manifest = await exportArtifact(directory, rows, { synthetic: "true" });
  await rehearse(directory);
  await assert.rejects(rehearse(directory), { code: "EEXIST" });
  const db = new DatabaseSync(join(directory, "rehearsal.sqlite"));
  try {
    db.exec('UPDATE "Student" SET "email"=\'changed@example.invalid\'');
    const changed: Rows = async function* (table) {
      for (const row of db
        .prepare(
          `SELECT ${TABLES[table].map((c) => quote(c.name)).join(",")} FROM ${quote(table)} ORDER BY ${quote(keyColumn(table))} COLLATE BINARY`,
        )
        .iterate()) {
        yield rawRowSchema.parse(row);
      }
    };
    await assert.rejects(verifyRows(manifest, changed), /comparison failed/);
  } finally {
    db.close();
  }
  await writeFile(join(directory, manifest.files[1]!.name), "-- tampered\n", { mode: 0o600 });
  await assert.rejects(loadArtifact(directory), /integrity/);
});

test("target checks reject identity mismatch and nonempty DB; import plan itself makes no requests", async () => {
  const identity = {
    account: "a".repeat(32),
    database: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "synthetic-only",
  };
  const reply = (result: { uuid: string; name: string } | { success: boolean; results: RawRow[] }[]) =>
    new Response(JSON.stringify({ success: true, result }));
  const mismatch = new D1Target(identity, "synthetic-token", async () =>
    reply({ uuid: identity.database, name: "wrong-name" }),
  );
  await assert.rejects(mismatch.confirmIdentity(), /identity mismatch/);
  const occupied = new D1Target(identity, "synthetic-token", async (_url, options) =>
    options?.method === "GET"
      ? reply({ uuid: identity.database, name: identity.name })
      : reply([{ success: true, results: [{ name: "Student" }] }]),
  );
  await assert.rejects(occupied.assertEmpty(), /not empty/);
  await assert.rejects(occupied.query("DELETE FROM Student"), /Only SELECT/);
  const directory = await newDirectory();
  await exportArtifact(directory, fixture().rows, { synthetic: "true" });
  await assert.rejects(prepareImport(directory, identity), { code: "ENOENT" });
  await rehearse(directory);
  await prepareImport(directory, identity);
  const script = await readFile(join(directory, "import-reviewed.sh"), "utf8");
  assert.match(script, /--empty/);
  assert.match(script, /--remote --yes --file/);
  assert.match(script, /--verify/);
  assert.ok(!script.includes("synthetic-token"));
  assert.equal((await stat(join(directory, "import-reviewed.sh"))).mode & 0o077, 0);
  await assert.rejects(prepareImport(directory, identity), { code: "EEXIST" });
});

test("read-only D1 calls throttle and honor bounded cooldowns without retrying authorization failures", async () => {
  const identity = {
    account: "b".repeat(32),
    database: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "synthetic-retry",
  };
  let time = 1_000;
  const delays: number[] = [];
  const timing = {
    now: () => time,
    wait: async (ms: number) => {
      delays.push(ms);
      time += ms;
    },
  };
  let calls = 0;
  const target = new D1Target(
    identity,
    "synthetic-token",
    async (_url, options) => {
      assert.equal(options?.redirect, "error");
      calls++;
      if (calls === 1) {
        return new Response("withheld", { status: 429, headers: { "Retry-After": "2" } });
      }
      return new Response(JSON.stringify({ success: true, result: { uuid: identity.database, name: identity.name } }));
    },
    timing,
  );
  await target.confirmIdentity();
  await target.confirmIdentity();
  assert.deepEqual(delays, [2000, 300]);
  assert.equal(calls, 3);
  let deniedCalls = 0;
  const denied = new D1Target(
    identity,
    "synthetic-token",
    async () => {
      deniedCalls++;
      return new Response("withheld", { status: 403 });
    },
    timing,
  );
  await assert.rejects(denied.confirmIdentity(), /HTTP 403/);
  assert.equal(deniedCalls, 1);
  let exhaustedCalls = 0;
  const exhausted = new D1Target(
    identity,
    "synthetic-token",
    async () => {
      exhaustedCalls++;
      throw new Error("synthetic transport failure");
    },
    timing,
  );
  await assert.rejects(exhausted.confirmIdentity(), /retries exhausted/);
  assert.equal(exhaustedCalls, 4);
});

test("exact pre-cutover delta covers inserts, updates, deletes and replacement reference set atomically", async () => {
  const baseDirectory = await newDirectory();
  const finalDirectory = await newDirectory();
  const baseFixture = fixture();
  const finalFixture = fixture();
  finalFixture.tables.Student[0]!.phone = "synthetic-phone";
  finalFixture.tables.ClassInfo[0]!.courseTitle = "Synthetic changed title";
  finalFixture.tables.WatchedSection = [
    { ...finalFixture.tables.WatchedSection[1]!, paidId: "00999999" },
    record("WatchedSection", {
      id: "w03",
      section: "00003",
      semester: "20281",
      paidId: "00000002",
      studentId: "s01",
      classInfoId: "c01",
    }),
  ];
  finalFixture.tables.NotificationSent = [
    record("NotificationSent", { id: "n02", sectionId: "w03", studentId: "s01" }),
  ];
  finalFixture.tables.PaymentReference = [{ paidId: "00000002" }, { paidId: "00999999" }];
  const source = { identitySha256: "a".repeat(64), synthetic: "true" };
  const base = await exportArtifact(baseDirectory, baseFixture.rows, source);
  const final = await exportArtifact(finalDirectory, finalFixture.rows, source);
  await rehearse(baseDirectory);
  await rehearse(finalDirectory);
  await assert.rejects(prepareDelta(baseDirectory, finalDirectory, 1), /exceeds 1 changes/);
  await assert.rejects(readFile(join(finalDirectory, `delta-from-${base.snapshotId}.json`)), { code: "ENOENT" });
  const { plan, path } = await prepareDelta(baseDirectory, finalDirectory);
  assert.equal(plan.changes.length, 10);
  assert.equal(plan.preCutoverOnly, true);
  assert.equal(plan.referencePolicy, "exact-final-distinct-before-first-D1-write");
  assert.equal((await stat(path)).mode & 0o077, 0);
  assert.equal(plan.changes.filter((change) => change.table === "PaymentReference").length, 3);
  const patched = new DatabaseSync(join(baseDirectory, "rehearsal.sqlite"));
  try {
    patched.exec(
      'BEGIN; PRAGMA defer_foreign_keys=ON; DROP TRIGGER "WatchedSection_reserve_paidId_insert"; DROP TRIGGER "WatchedSection_reserve_paidId_update";',
    );
    for (const change of plan.changes) {
      const existing = patched
        .prepare(
          `SELECT ${TABLES[change.table].map((column) => quote(column.name)).join(",")} FROM ${quote(change.table)} WHERE ${quote(keyColumn(change.table))}=?`,
        )
        .get(change.key);
      assert.deepEqual(existing ? normalizeRow(change.table, rawRowSchema.parse(existing)) : null, change.before);
      if (change.kind === "delete") {
        patched.prepare(`DELETE FROM ${quote(change.table)} WHERE ${quote(keyColumn(change.table))}=?`).run(change.key);
      } else if (change.kind === "insert") {
        patched.exec(insertStatement(change.table, [change.after!]));
      } else {
        patched
          .prepare(
            `UPDATE ${quote(change.table)} SET ${TABLES[change.table].map((column) => `${quote(column.name)}=?`).join(",")} WHERE ${quote(keyColumn(change.table))}=?`,
          )
          .run(...change.after!, change.key);
      }
    }
    patched.exec(await readFile(join(finalDirectory, final.files.at(-1)!.name), "utf8"));
    assert.equal(patched.prepare("SELECT count(*) AS n FROM pragma_foreign_key_check").get()!.n, 0);
    patched.exec("COMMIT;");
    const actual: Rows = async function* (table) {
      for (const row of patched
        .prepare(
          `SELECT ${TABLES[table].map((column) => quote(column.name)).join(",")} FROM ${quote(table)} ORDER BY ${quote(keyColumn(table))} COLLATE BINARY`,
        )
        .iterate()) {
        yield rawRowSchema.parse(row);
      }
    };
    await verifyRows(final, actual);
  } finally {
    patched.close();
  }
  await assert.rejects(prepareDelta(baseDirectory, finalDirectory), /digest mismatch/);
});

test("unchanged distinct snapshots produce an empty delta and different-source snapshots are rejected", async () => {
  const a = await newDirectory();
  const b = await newDirectory();
  const c = await newDirectory();
  for (const [directory, identity] of [
    [a, "a"],
    [b, "a"],
    [c, "b"],
  ]) {
    await exportArtifact(directory!, fixture().rows, { identitySha256: identity!.repeat(64) });
    await rehearse(directory!);
  }
  const { plan } = await prepareDelta(a, b, 0);
  assert.equal(plan.changes.length, 0);
  await assert.rejects(prepareDelta(a, c), /same source/);
  await assert.rejects(prepareDelta(a, a), /distinct snapshots/);
});

test("buffered SQL output keeps exact hashes and all rows across 8MiB file boundaries", async () => {
  const directory = await newDirectory();
  const rows: Rows = async function* (table) {
    if (table !== "Student") {
      return;
    }
    for (let index = 0; index < 6000; index++) {
      const key = String(index).padStart(6, "0");
      yield record("Student", {
        id: `s${key}`,
        email: `synthetic-${key}-${"x".repeat(800)}@example.invalid`,
        verificationKey: `synthetic-${key}`,
        createdAt: "1793574000123.000",
      });
    }
  };
  const manifest = await exportArtifact(directory, rows, { synthetic: "true" });
  const dataFiles = manifest.files.filter((file) => file.phase === "data");
  assert.ok(dataFiles.length >= 2);
  for (const file of dataFiles) {
    assert.ok(file.bytes <= 8 * 1024 * 1024);
    assert.equal(await hashFile(join(directory, file.name)), file.sha256);
  }
  const counts = await rehearse(directory);
  assert.equal(counts.Student, 6000);
  assert.equal(counts.PaymentReference, 0);
});
