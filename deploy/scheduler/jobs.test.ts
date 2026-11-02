import assert from "node:assert/strict";
import test from "node:test";
import { createTask, enqueue, isCurrentTask, schedulerTaskSchema, taskScope, type SchedulerTask } from "./jobs.ts";

test("task identities are canonical and continuation identities include their immutable cursor", async () => {
  const first = await createTask({ kind: "availability", semester: "20271", department: "CSCI", scheduledAt: 1000 });
  const reordered = await createTask({
    scheduledAt: 1000,
    department: "CSCI",
    semester: "20271",
    kind: "availability",
    afterWatchId: undefined,
  });
  assert.equal(first.id, reordered.id);
  assert.equal(JSON.stringify(first), JSON.stringify(reordered));
  assert.match(first.id, /^[a-f0-9]{64}$/);
  const next = await createTask({
    kind: "availability",
    semester: "20271",
    department: "CSCI",
    scheduledAt: 1000,
    afterWatchId: "watch-050",
  });
  const replay = await createTask({
    kind: "availability",
    semester: "20271",
    department: "CSCI",
    scheduledAt: 1000,
    afterWatchId: "watch-050",
  });
  assert.deepEqual(next, replay);
  assert.notEqual(first.id, next.id);
  assert.equal(taskScope(first), taskScope(next), "pages for one department share the same lease");
  assert.equal(next.scheduledAt, first.scheduledAt);
  const anotherDepartment = await createTask({
    kind: "availability",
    semester: "20271",
    department: "EE",
    scheduledAt: 1000,
  });
  assert.notEqual(taskScope(first), taskScope(anotherDepartment));
  const cursor = {
    version: 1,
    scanSince: 0,
    mailbox: "INBOX",
    uidValidity: "123",
    upperUid: 100,
    afterUid: 50,
  } as const;
  const gmail = await createTask({ kind: "gmail", scheduledAt: 1000, cursor });
  const gmailAgain = await createTask({ kind: "gmail", scheduledAt: 1000, cursor: { ...cursor } });
  assert.deepEqual(gmail, gmailAgain);
  assert.notEqual(
    gmail.id,
    (await createTask({ kind: "gmail", scheduledAt: 1000, cursor: { ...cursor, afterUid: 51 } })).id,
  );
  assert.equal(taskScope(gmail), "gmail");
});

test("task validity rejects expired/future messages before the dedupe retention window", async () => {
  const now = 1_790_000_000_000;
  const task = await createTask({ kind: "paid", scheduledAt: now });
  assert.equal(isCurrentTask(task, now), true);
  assert.equal(isCurrentTask({ ...task, scheduledAt: now - 86_400_000 }, now), true);
  assert.equal(isCurrentTask({ ...task, scheduledAt: now - 86_400_001 }, now), false);
  assert.equal(isCurrentTask({ ...task, scheduledAt: now + 60_000 }, now), true);
  assert.equal(isCurrentTask({ ...task, scheduledAt: now + 60_001 }, now), false);
  assert.equal(schedulerTaskSchema.safeParse({ ...task, afterId: "x".repeat(129) }).success, false);
  assert.equal(schedulerTaskSchema.safeParse({ ...task, unexpected: "ignored?" }).success, false);
  assert.equal(schedulerTaskSchema.safeParse({ ...task, id: "not-a-hash" }).success, false);
});

test("catalog task watermarks remain bound to their immutable scheduling time", async () => {
  const catalog = await createTask({
    kind: "catalog",
    semester: "20271",
    department: "CSCI",
    scheduledAt: 1000,
    capturedAt: 1000,
  });
  assert.equal(catalog.kind, "catalog");
  assert.deepEqual(
    catalog,
    await createTask({ kind: "catalog", semester: "20271", department: "CSCI", scheduledAt: 1000, capturedAt: 1000 }),
  );
  await assert.rejects(
    createTask({ kind: "catalog", semester: "20271", department: "CSCI", scheduledAt: 1000, capturedAt: 1001 }),
  );
});

test("queue publication stays within 100-message batches and stops after an uncertain publication", async () => {
  const tasks = await Promise.all(
    Array.from({ length: 205 }, (_, index) => createTask({ kind: "paid", scheduledAt: index })),
  );
  const batches: SchedulerTask[][] = [];
  await enqueue(
    {
      sendBatch: async (messages) => {
        batches.push(messages.map(({ body }) => body));
      },
    },
    tasks,
  );
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 5],
  );
  assert.deepEqual(batches.flat(), tasks);
  let calls = 0;
  await assert.rejects(
    enqueue(
      {
        sendBatch: async () => {
          calls++;
          if (calls === 2) {
            throw new Error("Uncertain synthetic publication");
          }
        },
      },
      tasks,
    ),
    /Uncertain synthetic publication/,
  );
  assert.equal(calls, 2, "publication failures are not silently retried or skipped");
});
