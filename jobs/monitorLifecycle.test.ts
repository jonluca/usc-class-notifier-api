import assert from "node:assert/strict";
import test from "node:test";
import { MonitorLifecycle } from "./monitorLifecycle";

test("maintenance admits no startup jobs and still closes cleanly", async () => {
  let work = 0;
  let closed = 0;
  const lifecycle = new MonitorLifecycle({
    maintenance: true,
    stopScheduling: () => {},
    closeDatabase: async () => {
      closed += 1;
    },
  });
  await lifecycle.run(async () => {
    work += 1;
  });
  assert.equal(work, 0);
  assert.deepEqual(await lifecycle.drain(), { drained: true, remainingJobs: 0 });
  assert.equal(closed, 1);
});

test("drain stops admissions synchronously and waits for every active job before disconnecting", async () => {
  const tasks = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  let stops = 0;
  let closes = 0;
  let lateWork = 0;
  const lifecycle = new MonitorLifecycle({
    maintenance: false,
    stopScheduling: () => {
      stops += 1;
    },
    closeDatabase: async () => {
      closes += 1;
    },
  });
  const running = tasks.map((task) => lifecycle.run(() => task.promise));
  const drain = lifecycle.drain();
  assert.equal(lifecycle.drain(), drain, "a second signal does not run a second shutdown");
  await lifecycle.run(async () => {
    lateWork += 1;
  });
  assert.equal(stops, 1);
  assert.equal(lateWork, 0);
  for (const task of tasks.slice(0, 3)) {
    task.resolve();
  }
  await Promise.all(running.slice(0, 3));
  assert.equal(closes, 0);
  assert.equal(lifecycle.activeJobs, 1);
  tasks[3]!.resolve();
  await Promise.all(running);
  assert.deepEqual(await drain, { drained: true, remainingJobs: 0 });
  assert.equal(closes, 1);
});

test("a failed job still settles; a stuck job hits the bounded deadline without premature disconnect", async () => {
  const stuck = Promise.withResolvers<void>();
  let closes = 0;
  const lifecycle = new MonitorLifecycle({
    maintenance: false,
    stopScheduling: () => {},
    closeDatabase: async () => {
      closes += 1;
    },
  });
  const running = lifecycle.run(() => stuck.promise);
  await assert.rejects(
    lifecycle.run(async () => {
      throw new Error("synthetic task failure");
    }),
    /synthetic/,
  );
  assert.deepEqual(await lifecycle.drain(5), { drained: false, remainingJobs: 1 });
  assert.equal(closes, 0);
  stuck.resolve();
  await running;
});

test("database disconnect shares the shutdown deadline", async () => {
  const disconnect = Promise.withResolvers<void>();
  const lifecycle = new MonitorLifecycle({
    maintenance: false,
    stopScheduling: () => {},
    closeDatabase: () => disconnect.promise,
  });
  assert.deepEqual(await lifecycle.drain(5), { drained: false, remainingJobs: 0 });
  disconnect.resolve();
});
