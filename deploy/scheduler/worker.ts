import { z } from "zod";
import { GmailVenmoImapClient } from "../../jobs/venmoGmail/gmailClient.ts";
import { GmailPageError } from "../../jobs/venmoGmail/gmailPagination.ts";
import {
  getAvailabilityDepartments,
  getCatalogDepartments,
  refreshCatalogDepartment,
  runAvailabilityDepartment,
} from "../../src/server/api/controller.ts";
import { getValidSemesters } from "../../src/utils/semester.ts";
import type { D1Binding } from "../../src/server/d1/protocol.ts";
import { createNativeD1Binding, initializeSchedulerDatabase, prisma } from "./db.ts";
import { SchedulerStore, SCHEDULER_RETENTION_MS, type SchedulerSummary } from "./store.ts";
import { runPaidNotificationPage } from "./paidNotifications.ts";
import { sendMessage } from "./twilio.ts";
import {
  createTask,
  enqueue,
  isCurrentTask,
  schedulerTaskSchema,
  taskScope,
  type SchedulerTask,
  type SchedulerQueue,
  type SchedulerMessage,
} from "./jobs.ts";

export interface SchedulerEnvironment {
  DB: D1Binding;
  TASKS: SchedulerQueue;
  SCHEDULER_TOKEN: string;
  APP_REVISION: string;
}
const triggers = z.enum(["five", "fifteen", "daily"]);
type Trigger = z.infer<typeof triggers>;
const cronSchema = z.enum(["*/5 * * * *", "2,17,32,47 * * * *", "15 10 * * *"]);
const cronTriggers = {
  "*/5 * * * *": "five",
  "2,17,32,47 * * * *": "fifteen",
  "15 10 * * *": "daily",
} satisfies Record<z.infer<typeof cronSchema>, Trigger>;
function storeFor(env: SchedulerEnvironment): SchedulerStore {
  initializeSchedulerDatabase(env.DB);
  return new SchedulerStore(createNativeD1Binding(env.DB));
}
function errorCode(error: Error): string {
  if (error instanceof GmailPageError) {
    return `gmail_${error.code}`;
  }
  if (["AbortError", "TimeoutError", "CanceledError"].includes(error.name)) {
    return "upstream_timeout";
  }
  return "job_failed";
}
function event(name: string, fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: name, ...fields }));
}

export async function dispatch(env: SchedulerEnvironment, trigger: Trigger, scheduledAt: number): Promise<number> {
  const store = storeFor(env);
  if (!(await store.isEnabled())) {
    return 0;
  }
  const tasks: SchedulerTask[] = [];
  // Stable slots deduplicate Cron retries and an operator's repeated dispatch.
  const interval = trigger === "five" ? 300_000 : trigger === "fifteen" ? 900_000 : 1;
  const slot = Math.floor(scheduledAt / interval) * interval;
  if (trigger === "fifteen") {
    tasks.push(await createTask({ kind: "gmail", scheduledAt: slot }));
  } else {
    if (trigger === "five") {
      tasks.push(await createTask({ kind: "paid", scheduledAt: slot }));
    }
    for (const semester of getValidSemesters()) {
      const departments =
        trigger === "five" ? await getAvailabilityDepartments(semester) : await getCatalogDepartments(semester);
      for (const department of departments) {
        tasks.push(
          await createTask(
            trigger === "five"
              ? { kind: "availability", semester, department, scheduledAt: slot }
              : { kind: "catalog", semester, department, scheduledAt: slot, capturedAt: slot },
          ),
        );
      }
    }
  }
  await enqueue(env.TASKS, tasks);
  if (trigger === "daily") {
    await store.prune(Date.now() - SCHEDULER_RETENTION_MS);
  }
  event("usc_scheduler_dispatched", { trigger, tasks: tasks.length });
  return tasks.length;
}

export interface TaskResult {
  summary: SchedulerSummary;
  continuation?: SchedulerTask;
}
export async function executeTask(task: SchedulerTask): Promise<TaskResult> {
  if (task.kind === "catalog") {
    return { summary: await refreshCatalogDepartment(task.department, task.semester, { capturedAt: task.capturedAt }) };
  }
  if (task.kind === "availability") {
    const page = await runAvailabilityDepartment(task.department, task.semester, {
      afterWatchId: task.afterWatchId,
      limit: 10,
    });
    const result: TaskResult = {
      summary: {
        processedWatches: page.processedWatches,
        completedWatches: page.completedWatches,
        failedWatches: page.failedWatches,
        hasMore: Boolean(page.nextCursor),
      },
    };
    if (page.nextCursor) {
      result.continuation = await createTask({
        kind: task.kind,
        department: task.department,
        semester: task.semester,
        scheduledAt: task.scheduledAt,
        afterWatchId: page.nextCursor,
      });
    }
    return result;
  }
  if (task.kind === "gmail") {
    const page = await new GmailVenmoImapClient().checkPage({ cursor: task.cursor, pageSize: 100 });
    const result: TaskResult = { summary: { ...page.summary, hasMore: Boolean(page.nextCursor) } };
    if (page.nextCursor) {
      result.continuation = await createTask({
        kind: task.kind,
        scheduledAt: task.scheduledAt,
        cursor: page.nextCursor,
      });
    }
    return result;
  }
  const page = await runPaidNotificationPage({ afterId: task.afterId, limit: 10 });
  const result: TaskResult = { summary: { ...page.summary, hasMore: Boolean(page.nextCursor) } };
  if (page.nextCursor) {
    result.continuation = await createTask({
      kind: task.kind,
      scheduledAt: task.scheduledAt,
      afterId: page.nextCursor,
    });
  }
  return result;
}

async function alertGmailFailure(code: string): Promise<void> {
  const destination = process.env.TO_NUMBER;
  if (!destination) {
    throw new Error("Scheduler alert destination is missing");
  }
  await sendMessage({
    to: destination,
    message: `USC payment inbox check failed after 3 attempts (${code}). Scheduled checks continue every 15 minutes.`,
  });
}

export interface ConsumerDependencies {
  store?: SchedulerStore;
  execute?: typeof executeTask;
  now?: () => number;
  alert?: (code: string) => Promise<void>;
}
export async function consumeMessage(
  message: SchedulerMessage,
  env: SchedulerEnvironment,
  dependencies: ConsumerDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const parsed = schedulerTaskSchema.safeParse(message.body);
  if (!parsed.success || !isCurrentTask(parsed.data, now())) {
    event("usc_scheduler_invalid_message", {});
    message.ack();
    return;
  }
  const task = parsed.data,
    store = dependencies.store ?? storeFor(env),
    scope = taskScope(task);
  if (!(await store.isEnabled())) {
    message.retry({ delaySeconds: 60 });
    return;
  }
  if ((await createTask(task)).id !== task.id) {
    message.ack();
    return;
  }
  const claim = await store.claim({ id: task.id, kind: task.kind, scope, scheduledAt: task.scheduledAt }, now());
  if (claim.status !== "claimed") {
    if (claim.status === "completed") {
      message.ack();
    } else {
      message.retry({ delaySeconds: 60 });
    }
    return;
  }
  const started = now();
  try {
    const result = await (dependencies.execute ?? executeTask)(task);
    // Publish before completion: a lost queue response can duplicate a continuation,
    // but its deterministic ID and durable claim prevent repeated completed work.
    if (result.continuation) {
      await enqueue(env.TASKS, [result.continuation]);
    }
    if (
      !(await store.complete(task.id, scope, claim.token, { ...result.summary, durationMs: now() - started }, now()))
    ) {
      throw new Error("Scheduler lease lost");
    }
    event("usc_scheduler_completed", { kind: task.kind, durationMs: now() - started });
    message.ack();
  } catch (error) {
    const code = errorCode(error instanceof Error ? error : new Error("Unknown scheduler failure"));
    let failureRecorded = false;
    try {
      failureRecorded = await store.fail(task.id, scope, claim.token, code, now());
    } catch {
      event("usc_scheduler_ledger_failed", { kind: task.kind });
    }
    event("usc_scheduler_failed", { kind: task.kind, code });
    if (task.kind === "gmail" && claim.attempts >= 3 && failureRecorded) {
      try {
        if (await store.claimAlert(task.id, now())) {
          await (dependencies.alert ?? alertGmailFailure)(code);
        }
      } catch {
        event("usc_scheduler_alert_failed", { kind: task.kind });
      }
    }
    // Read/idempotent reconciliation tasks may retry. Sending jobs retain the
    // normal next-Cron retry cadence rather than adding immediate send retries.
    if ((task.kind === "catalog" || task.kind === "gmail") && claim.attempts < 3) {
      message.retry({ delaySeconds: 60 });
    } else {
      message.ack();
    }
  }
}

async function authorized(request: Request, expected: string): Promise<boolean> {
  if (!expected || expected.length < 32) {
    return false;
  }
  const supplied = request.headers.get("authorization") || "";
  if (supplied.length > 1024) {
    return false;
  }
  const encode = (text: string) => new TextEncoder().encode(text);
  const [actual, wanted] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(supplied)),
    crypto.subtle.digest("SHA-256", encode(`Bearer ${expected}`)),
  ]);
  const a = new Uint8Array(actual),
    b = new Uint8Array(wanted);
  return a.reduce((difference, value, i) => difference | (value ^ b[i]!), 0) === 0;
}
const response = <T>(body: T, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
export default {
  async fetch(request: Request, env: SchedulerEnvironment): Promise<Response> {
    if (!(await authorized(request, env.SCHEDULER_TOKEN))) {
      return response({ error: "unauthorized" }, 401);
    }
    const path = new URL(request.url).pathname;
    try {
      const store = storeFor(env);
      if (request.method === "GET" && path === "/health") {
        return response({ ready: true, provider: "d1", revision: env.APP_REVISION, ...(await store.health()) });
      }
      if (request.method === "POST" && path === "/dispatch") {
        if (!(await store.isEnabled())) {
          return response({ error: "disabled" }, 409);
        }
        const body = z
          .object({ trigger: triggers })
          .strict()
          .parse(await request.json());
        return response({ queued: await dispatch(env, body.trigger, Date.now()) });
      }
      if (request.method === "POST" && path === "/canary") {
        const body = z
          .object({ gmail: z.boolean().default(false) })
          .strict()
          .parse(await request.json());
        const [students, watches, classes, notifications] = await Promise.all([
          prisma.student.count(),
          prisma.watchedSection.count(),
          prisma.classInfo.count(),
          prisma.notificationSent.count(),
        ]);
        const semesters = getValidSemesters();
        const departments = semesters.length ? await getCatalogDepartments(semesters[0]!) : [];
        const gmail = body.gmail ? await new GmailVenmoImapClient().fetchPage({ pageSize: 1 }) : null;
        return response({
          ready: true,
          applicationWrites: 0,
          sends: 0,
          counts: { students, watches, classes, notifications },
          semesters: semesters.length,
          departments: departments.length,
          gmail: gmail ? { ...gmail.summary, hasMore: Boolean(gmail.nextCursor) } : null,
        });
      }
      return response({ error: "not_found" }, 404);
    } catch (error) {
      return response(
        { error: errorCode(error instanceof Error ? error : new Error("Unknown scheduler failure")) },
        503,
      );
    }
  },
  async scheduled(controller: { cron: string; scheduledTime: number }, env: SchedulerEnvironment): Promise<void> {
    const cron = cronSchema.parse(controller.cron);
    const trigger = cronTriggers[cron];
    await dispatch(env, trigger, controller.scheduledTime);
  },
  async queue(batch: { messages: SchedulerMessage[] }, env: SchedulerEnvironment): Promise<void> {
    for (const message of batch.messages) {
      await consumeMessage(message, env);
    }
  },
};
