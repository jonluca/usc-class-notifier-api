import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestClient } from "../../src/server/d1/testing.ts";
import { createD1PrismaClient } from "../../src/server/d1/client.ts";
import { getD1Executor } from "../../src/server/d1/executor.ts";
import { createNativeD1Binding, initializeSchedulerDatabase, prisma } from "./db.ts";

test("native scheduler D1 preserves Prisma reads, millisecond dates and atomic guard rollback", async () => {
  const fixture = await createD1TestClient();
  const binding = createNativeD1Binding(fixture.native);
  const client = createD1PrismaClient(binding);
  try {
    const date = new Date("2026-01-02T03:04:05.678Z");
    const student = await client.student.create({
      data: {
        id: "scheduler-student",
        email: "synthetic@example.invalid",
        verificationKey: "synthetic",
        createdAt: date,
      },
    });
    assert.equal(student.createdAt?.getTime(), date.getTime());
    assert.equal(student.validAccount, false);
    assert.equal(student.phone, null);
    assert.equal(await client.student.count({ where: { createdAt: date } }), 1);
    const course = await client.classInfo.create({
      data: { section: "10000", semester: "20263", department: "CSCI", courseNumber: "101", courseTitle: "Synthetic" },
    });
    const watch = await client.watchedSection.create({
      data: {
        id: "scheduler-watch",
        studentId: student.id,
        classInfoId: course.id,
        section: "10000",
        semester: "20263",
        paidId: "12345678",
      },
    });
    assert.equal(
      (await client.watchedSection.findFirstOrThrow({ include: { student: true, ClassInfo: true } })).student.id,
      student.id,
    );
    assert.equal(getD1Executor(client), binding);
    await assert.rejects(
      binding.batch([
        { sql: 'UPDATE "WatchedSection" SET "notified" = 1 WHERE id = ?', params: [watch.id] },
        { sql: "INSERT INTO D1Invariant (id, value) VALUES (?, 0)", params: ["rollback"] },
      ]),
      /CHECK constraint failed/,
    );
    assert.equal((await client.watchedSection.findUniqueOrThrow({ where: { id: watch.id } })).notified, false);
    await binding.batch([
      { sql: 'UPDATE "WatchedSection" SET "notified" = 1 WHERE id = ?', params: [watch.id] },
      {
        sql: "INSERT INTO D1Invariant (id, value) VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)",
        params: ["passed"],
      },
      { sql: "DELETE FROM D1Invariant WHERE id = ?", params: ["passed"] },
    ]);
    assert.equal((await client.watchedSection.findUniqueOrThrow({ where: { id: watch.id } })).notified, true);
    await assert.rejects(client.student.create({ data: { email: student.email, verificationKey: "duplicate" } }), {
      code: "P2002",
    });
    await assert.rejects(
      client.$transaction(async () => undefined),
      /transactions are disabled/,
    );
    assert.deepEqual(
      await binding.prepare("SELECT email FROM Student WHERE id = ?").bind("missing").raw({ columnNames: true }),
      [["email"]],
    );
    await assert.rejects(binding.query("SELECT private_literal_not_a_column"), /^Error: D1 query failed$/);
    initializeSchedulerDatabase(fixture.native);
    assert.equal(await prisma.student.count(), 1);
    assert.equal(
      (await getD1Executor(prisma)!.query<{ count: number }>("SELECT COUNT(*) AS count FROM Student"))[0]?.count,
      1,
    );
  } finally {
    await client.$disconnect();
    await fixture.dispose();
  }
});

test("Cloudflare-generated Prisma executes against a native binding inside workerd across invocations", async () => {
  const { build } = await import("esbuild");
  const { Miniflare } = await import("miniflare");
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `
        import { initializeSchedulerDatabase, prisma } from './deploy/scheduler/db.ts';
        import { getD1Executor } from './src/server/d1/executor.ts';
        export default { async fetch(request, env) {
          initializeSchedulerDatabase(env.DB);
          const executor = getD1Executor(prisma);
          const date = new Date('2026-01-02T03:04:05.678Z');
          await prisma.student.upsert({
            where: { id: 'workerd-student' },
            create: { id:'workerd-student', email:'workerd@example.invalid', verificationKey:'synthetic',createdAt:date },
            update: {validAccount:true}, select:{id:true}
          });
          let rollback = false;
          try { await executor.batch([
            {sql:'UPDATE Student SET validAccount=1 WHERE id=?',params:['workerd-student']},
            {sql:'INSERT INTO D1Invariant(id,value) VALUES(?,0)',params:['rollback']}
          ]); } catch { rollback = true; }
          const student = await prisma.student.findUniqueOrThrow({where:{id:'workerd-student'}});
          return Response.json({ rollback, date:student.createdAt.getTime(), count:await prisma.student.count({where:{createdAt:date}}), phone:student.phone });
        }};
      `,
      resolveDir: root,
      sourcefile: "scheduler-native-test.ts",
      loader: "ts",
    },
    alias: { "@app/prisma-d1": `${root}prisma/generated-d1-worker/client.ts` },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*"],
    plugins: [
      {
        name: "native-wasm-module",
        setup(builder) {
          builder.onResolve({ filter: /\.wasm\?module$/ }, () => ({ path: "./query-compiler.wasm", external: true }));
        },
      },
    ],
  });
  const mf = new Miniflare({
    modules: [
      { type: "ESModule", path: "worker.mjs", contents: bundle.outputFiles[0]!.text },
      {
        type: "CompiledWasm",
        path: "query-compiler.wasm",
        contents: await readFile(`${root}prisma/generated-d1-worker/internal/query_compiler_fast_bg.wasm`),
      },
    ],
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "usc-native-worker-test" },
  });
  try {
    const native = await mf.getD1Database("DB");
    const schema = await readFile(`${root}prisma/d1/migrations/0001_schema.sql`, "utf8");
    for (const sql of schema
      .replace(/^--.*$/gm, "")
      .split(";")
      .filter((value) => value.trim())) {
      await native.prepare(sql).run();
    }
    for (let i = 0; i < 2; i++) {
      const response = await mf.dispatchFetch("https://local.invalid/");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { rollback: true, date: 1767323045678, count: 1, phone: null });
    }
  } finally {
    await mf.dispose();
  }
});
