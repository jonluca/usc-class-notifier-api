import { z } from "zod";
import { gmailCursorSchema } from "../../jobs/venmoGmail/gmailPagination.ts";

const common = {
  version: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  scheduledAt: z.number().int().nonnegative().safe(),
};
const offering = {
  semester: z.string().regex(/^\d{4}[123]$/),
  department: z.string().regex(/^[A-Z0-9-]{1,16}$/),
};
const taskUnionSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...common, kind: z.literal("availability"), ...offering, afterWatchId: z.string().max(128).optional() })
    .strict(),
  z
    .object({ ...common, kind: z.literal("catalog"), ...offering, capturedAt: z.number().int().nonnegative().safe() })
    .strict(),
  z.object({ ...common, kind: z.literal("gmail"), cursor: gmailCursorSchema.optional() }).strict(),
  z.object({ ...common, kind: z.literal("paid"), afterId: z.string().max(128).optional() }).strict(),
]);
export const schedulerTaskSchema = taskUnionSchema.refine(
  (task) => task.kind !== "catalog" || task.capturedAt === task.scheduledAt,
  "Catalog observation time must match its original task time",
);
export type SchedulerTask = z.infer<typeof schedulerTaskSchema>;
type Input<T> = T extends SchedulerTask ? Omit<T, "id" | "version"> : never;
export type SchedulerTaskInput = Input<SchedulerTask>;
export interface SchedulerQueue {
  sendBatch(messages: { body: SchedulerTask }[]): Promise<void>;
}
export interface SchedulerMessage {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

export async function createTask(input: SchedulerTaskInput): Promise<SchedulerTask> {
  // Parse before hashing so field order and optional fields are canonical.
  const parsed = schedulerTaskSchema.parse({ ...input, version: 1, id: "0".repeat(64) });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parsed)));
  parsed.id = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return parsed;
}

export function taskScope(task: SchedulerTask): string {
  return task.kind === "availability" || task.kind === "catalog"
    ? `${task.kind}:${task.semester}:${task.department}`
    : task.kind;
}

export function isCurrentTask(task: SchedulerTask, now = Date.now()): boolean {
  // Expire messages before their durable dedupe history can be pruned.
  return task.scheduledAt <= now + 60_000 && task.scheduledAt >= now - 24 * 60 * 60 * 1000;
}

export async function enqueue(queue: SchedulerQueue, tasks: SchedulerTask[]): Promise<void> {
  for (let offset = 0; offset < tasks.length; offset += 100) {
    await queue.sendBatch(tasks.slice(offset, offset + 100).map((body) => ({ body })));
  }
}
