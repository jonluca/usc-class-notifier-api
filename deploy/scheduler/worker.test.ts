import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createD1TestClient } from "../../src/server/d1/testing.ts";
import { SchedulerStore } from "./store.ts";
import { createTask, taskScope, type SchedulerTask, type SchedulerMessage } from "./jobs.ts";
import { consumeMessage, type SchedulerEnvironment } from "./worker.ts";

const NOW = 1_790_000_000_000;
interface DeliveryOutcome {
  acknowledged: number;
  retries: number[];
}
function delivery(body: SchedulerTask, attempts = 1) {
  const outcome: DeliveryOutcome = { acknowledged: 0, retries: [] };
  const message: SchedulerMessage = {
    body,
    attempts,
    ack: () => {
      outcome.acknowledged++;
    },
    retry: ({ delaySeconds }) => {
      outcome.retries.push(delaySeconds);
    },
  };
  return { message, outcome };
}
async function fixture() {
  const local = await createD1TestClient();
  const sql = await readFile(new URL("../../prisma/d1/migrations/0003_scheduler.sql", import.meta.url), "utf8");
  for (const statement of sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .filter((value) => value.trim())) {
    await local.native.prepare(statement).run();
  }
  const store = new SchedulerStore(local.executor);
  const published: SchedulerTask[] = [];
  const env: SchedulerEnvironment = {
    DB: local.native,
    TASKS: {
      sendBatch: async (messages) => {
        published.push(...messages.map(({ body }) => body));
      },
    },
    SCHEDULER_TOKEN: "synthetic-test-token-with-more-than-32-characters",
    APP_REVISION: "synthetic-test-revision",
  };
  return {
    ...local,
    store,
    env,
    published,
    enable: () => local.executor.query("UPDATE SchedulerControl SET enabled=1 WHERE id='scheduler'"),
  };
}

test("queue duplicates never invoke an external handler twice and active scopes retry", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const task = await createTask({ kind: "availability", semester: "20271", department: "CSCI", scheduledAt: NOW });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const dependencies = {
      store: f.store,
      alert: async () => {},
      now: () => NOW,
      execute: async () => {
        calls++;
        entered.resolve();
        await release.promise;
        return { summary: { processedWatches: 1 } };
      },
    };
    const first = delivery(task);
    const running = consumeMessage(first.message, f.env, dependencies);
    try {
      await entered.promise;
      const duplicate = delivery(task);
      await consumeMessage(duplicate.message, f.env, dependencies);
      assert.deepEqual(duplicate.outcome, { acknowledged: 0, retries: [60] });
      assert.equal(calls, 1);
    } finally {
      release.resolve();
      await running;
    }
    assert.equal(first.outcome.acknowledged, 1);
    const replay = delivery(task, 2);
    await consumeMessage(replay.message, f.env, dependencies);
    assert.deepEqual(replay.outcome, { acknowledged: 1, retries: [] });
    assert.equal(calls, 1);
    assert.equal((await f.store.health(NOW)).counts.completed, 1);
  } finally {
    await f.dispose();
  }
});

test("disabled, expired and mismatched-identity messages cannot invoke a handler", async () => {
  const f = await fixture();
  try {
    const task = await createTask({ kind: "paid", scheduledAt: NOW });
    const dependencies = {
      store: f.store,
      alert: async () => {},
      now: () => NOW,
      execute: async () => assert.fail("Unexpected external handler"),
    };
    const disabled = delivery(task);
    await consumeMessage(disabled.message, f.env, dependencies);
    assert.deepEqual(disabled.outcome, { acknowledged: 0, retries: [60] });
    await f.enable();
    for (const invalid of [
      await createTask({ kind: "paid", scheduledAt: NOW - 86_400_001 }),
      await createTask({ kind: "paid", scheduledAt: NOW + 60_001 }),
      { ...task, id: "0".repeat(64) },
    ]) {
      const message = delivery(invalid);
      await consumeMessage(message.message, f.env, dependencies);
      assert.deepEqual(message.outcome, { acknowledged: 1, retries: [] });
    }
    assert.equal((await f.store.health(NOW)).counts.total, 0);
  } finally {
    await f.dispose();
  }
});

test("failure retries are bounded for catalog/Gmail and send jobs wait for their next cron", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const tasks = await Promise.all([
      createTask({ kind: "catalog", semester: "20271", department: "CSCI", scheduledAt: NOW, capturedAt: NOW }),
      createTask({ kind: "gmail", scheduledAt: NOW }),
      createTask({ kind: "availability", semester: "20271", department: "CSCI", scheduledAt: NOW }),
      createTask({ kind: "paid", scheduledAt: NOW }),
    ]);
    const dependencies = {
      store: f.store,
      alert: async () => {},
      now: () => NOW,
      execute: async () => {
        throw new Error("synthetic private detail must not be logged");
      },
    };
    for (const task of tasks) {
      for (const [index, queueAttempt] of [1, 10, 20].entries()) {
        const message = delivery(task, queueAttempt);
        await consumeMessage(message.message, f.env, dependencies);
        assert.deepEqual(
          message.outcome,
          (task.kind === "catalog" || task.kind === "gmail") && index < 2
            ? { acknowledged: 0, retries: [60] }
            : { acknowledged: 1, retries: [] },
        );
      }
    }
    const health = await f.store.health(NOW);
    assert.equal(health.counts.failed, 4);
    assert.equal(health.activeLeases, 0);
  } finally {
    await f.dispose();
  }
});

test("uncertain continuation publication repeats a deterministic child and completed child replay is deduplicated", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const parent = await createTask({ kind: "gmail", scheduledAt: NOW });
    const child = await createTask({
      kind: "gmail",
      scheduledAt: NOW,
      cursor: { version: 1, mailbox: "INBOX", scanSince: NOW - 1000, uidValidity: "123", upperUid: 100, afterUid: 50 },
    });
    let publications = 0;
    f.env.TASKS.sendBatch = async (messages) => {
      f.published.push(...messages.map(({ body }) => body));
      publications++;
      if (publications === 1) {
        throw new Error("Publication accepted but reply lost");
      }
    };
    let parentCalls = 0,
      childCalls = 0;
    const dependencies = {
      store: f.store,
      alert: async () => {},
      now: () => NOW,
      execute: async (task: SchedulerTask) => {
        if (task.id === parent.id) {
          parentCalls++;
          return { summary: { scannedMessages: 50 }, continuation: child };
        }
        childCalls++;
        return { summary: { scannedMessages: 10 } };
      },
    };
    const first = delivery(parent);
    await consumeMessage(first.message, f.env, dependencies);
    assert.deepEqual(first.outcome, { acknowledged: 0, retries: [60] });
    assert.equal(f.published.length, 1);
    const retry = delivery(parent, 2);
    await consumeMessage(retry.message, f.env, dependencies);
    assert.deepEqual(retry.outcome, { acknowledged: 1, retries: [] });
    assert.equal(parentCalls, 2, "idempotent Gmail reconciliation may repeat after ambiguous publish");
    assert.deepEqual(
      f.published.map((task) => task.id),
      [child.id, child.id],
    );
    for (const queued of f.published) {
      const message = delivery(queued);
      await consumeMessage(message.message, f.env, dependencies);
      assert.equal(message.outcome.acknowledged, 1);
    }
    assert.equal(childCalls, 1);
    assert.equal(taskScope(parent), taskScope(child));
    assert.equal((await f.store.health(NOW)).counts.completed, 2);
  } finally {
    await f.dispose();
  }
});

test("send jobs still acknowledge handler failures when recording the failed ledger transition is unavailable", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const failingStore = new SchedulerStore({
      query: (sql, params) => f.executor.query(sql, params),
      batch: (statements) => {
        if (statements[0]?.sql.startsWith("UPDATE SchedulerRun SET status = ?")) {
          return Promise.reject(new Error("Synthetic ledger outage"));
        }
        return f.executor.batch(statements);
      },
    });
    const task = await createTask({ kind: "paid", scheduledAt: NOW });
    const message = delivery(task);
    await consumeMessage(message.message, f.env, {
      store: failingStore,
      now: () => NOW,
      execute: async () => {
        throw new Error("Synthetic sender failure");
      },
    });
    assert.deepEqual(message.outcome, { acknowledged: 1, retries: [] });
    assert.equal((await f.store.health(NOW)).counts.running, 1, "unreleased lease remains visible for expiry recovery");
  } finally {
    await f.dispose();
  }
});

test("full scheduler bundle runs in workerd with authenticated disabled health and no outbound requests", async () => {
  const { build } = await import("esbuild");
  const { Miniflare } = await import("miniflare");
  const { fileURLToPath } = await import("node:url");
  const { z } = await import("zod");
  const { builtinModules } = await import("node:module");
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const configText = await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8");
  const config = z
    .object({ alias: z.record(z.string(), z.string()) })
    .parse(JSON.parse(configText.replace(/,\s*([}\]])/g, "$1")));
  const alias = Object.fromEntries(
    Object.entries(config.alias).map(([name, relative]) => [
      name,
      fileURLToPath(new URL(relative, new URL("./", import.meta.url))),
    ]),
  );
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
    alias,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    banner: {
      js: "import { createRequire as schedulerTestCreateRequire } from 'node:module'; const require = schedulerTestCreateRequire('/worker.mjs');",
    },
    external: ["node:*"],
    plugins: [
      {
        name: "scheduler-test-wasm",
        setup(builder) {
          builder.onResolve({ filter: /^[a-z][a-z_/-]*$/ }, (args) =>
            builtins.has(args.path) ? { path: `node:${args.path}`, external: true } : undefined,
          );
          builder.onResolve({ filter: /\.wasm\?module$/ }, () => ({ path: "./query-compiler.wasm", external: true }));
        },
      },
    ],
  });
  let outbound = 0;
  const token = "synthetic-workerd-token-with-at-least-32-characters";
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
    d1Databases: { DB: "usc-scheduler-full-bundle-test" },
    bindings: { SCHEDULER_TOKEN: token, APP_REVISION: "synthetic-revision", NODE_ENV: "production" },
    outboundService: async () => {
      outbound++;
      throw new Error("Unexpected outbound request in disabled scheduler test");
    },
  });
  try {
    const native = await mf.getD1Database("DB");
    for (const migration of ["0001_schema.sql", "0003_scheduler.sql"]) {
      const sql = await readFile(`${root}prisma/d1/migrations/${migration}`, "utf8");
      for (const statement of sql
        .replace(/^--.*$/gm, "")
        .split(";")
        .filter((value) => value.trim())) {
        await native.prepare(statement).run();
      }
    }
    const unauthorized = await mf.dispatchFetch("https://local.invalid/health");
    assert.equal(unauthorized.status, 401);
    const headers = { authorization: `Bearer ${token}` };
    for (let i = 0; i < 2; i++) {
      const response = await mf.dispatchFetch("https://local.invalid/health", { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const health = z
        .object({
          ready: z.boolean(),
          enabled: z.boolean(),
          provider: z.string(),
          revision: z.string(),
          counts: z.object({ total: z.number() }),
        })
        .parse(await response.json());
      assert.deepEqual(health, {
        ready: true,
        enabled: false,
        provider: "d1",
        revision: "synthetic-revision",
        counts: { total: 0 },
      });
    }
    const disabled = await mf.dispatchFetch("https://local.invalid/dispatch", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ trigger: "five" }),
    });
    assert.equal(disabled.status, 409);
    assert.equal(outbound, 0);
  } finally {
    await mf.dispose();
  }
});

test("Gmail failure alerts are reserved once and an uncertain alert outcome never changes retry policy", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const task = await createTask({ kind: "gmail", scheduledAt: NOW });
    const alerts: string[] = [];
    const dependencies = {
      store: f.store,
      now: () => NOW,
      execute: async () => {
        throw new Error("Synthetic private inbox failure");
      },
      alert: async (code: string) => {
        alerts.push(code);
        throw new Error("Alert accepted but response lost");
      },
    };
    for (const attempt of [1, 2, 3]) {
      const message = delivery(task, attempt);
      await consumeMessage(message.message, f.env, dependencies);
      assert.deepEqual(
        message.outcome,
        attempt < 3 ? { acknowledged: 0, retries: [60] } : { acknowledged: 1, retries: [] },
      );
    }
    assert.deepEqual(alerts, ["job_failed"]);
    const health = await f.store.health(NOW);
    assert.equal(health.kinds[0]?.latest.attempts, 3);
    assert.equal(health.kinds[0]?.latest.alerted, 1);
    assert.equal(health.activeLeases, 0);
  } finally {
    await f.dispose();
  }
});

test("lease-wait retries do not consume the durable Gmail execution allowance", async () => {
  const f = await fixture();
  try {
    await f.enable();
    const task = await createTask({ kind: "gmail", scheduledAt: NOW });
    const blocker = { id: "earlier-gmail-run", kind: "gmail", scope: "gmail", scheduledAt: NOW - 1000 };
    const claim = await f.store.claim(blocker, NOW);
    assert.ok(claim.status === "claimed");
    assert.equal(claim.attempts, 1);
    let executions = 0;
    const dependencies = {
      store: f.store,
      now: () => NOW,
      alert: async () => {},
      execute: async () => {
        executions++;
        throw new Error("Synthetic safe reconciliation failure");
      },
    };
    const waiting = delivery(task, 7);
    await consumeMessage(waiting.message, f.env, dependencies);
    assert.deepEqual(waiting.outcome, { acknowledged: 0, retries: [60] });
    assert.equal(executions, 0);
    await f.store.complete(blocker.id, blocker.scope, claim.token, {}, NOW);
    const runnable = delivery(task, 8);
    await consumeMessage(runnable.message, f.env, dependencies);
    assert.deepEqual(runnable.outcome, { acknowledged: 0, retries: [60] });
    assert.equal(executions, 1);
    const run = await f.executor.query<{ attempts: number }>("SELECT attempts FROM SchedulerRun WHERE id = ?", [
      task.id,
    ]);
    assert.equal(run[0]?.attempts, 1);
  } finally {
    await f.dispose();
  }
});
