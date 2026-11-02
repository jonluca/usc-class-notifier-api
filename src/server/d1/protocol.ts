import { z } from "zod";
import type { D1BatchResult, D1Statement, D1Value } from "./executor.ts";

export const MAX_REQUEST_BYTES = 2_000_000;
export const MAX_RESPONSE_BYTES = 8_000_000;
export const MAX_BATCH_STATEMENTS = 256;
export const MAX_SQL_BYTES = 100_000;
export const MAX_PARAMETERS = 100;
export type QueryMode = "raw" | "all" | "run";

export const d1ValueSchema = z.union([z.string(), z.number().finite(), z.null()]);
export const d1RowSchema = z.record(z.string(), d1ValueSchema);
export const statementSchema = z
  .object({
    sql: z
      .string()
      .min(1)
      .refine((sql) => Boolean(sql.trim()) && new TextEncoder().encode(sql).length <= MAX_SQL_BYTES),
    params: z.array(d1ValueSchema).max(MAX_PARAMETERS).default([]),
  })
  .strict();
export const queryRequestSchema = z
  .object({ version: z.literal(1), mode: z.enum(["raw", "all", "run"]), statement: statementSchema })
  .strict();
export const batchRequestSchema = z
  .object({ version: z.literal(1), statements: z.array(statementSchema).min(1).max(MAX_BATCH_STATEMENTS) })
  .strict();
export const rawResultSchema = z.array(z.array(d1ValueSchema));
export const batchResultSchema = z.object({
  results: z.array(d1RowSchema),
  meta: z.object({ changes: z.number().int().nonnegative() }),
});
export const gatewayResponseSchema = z.discriminatedUnion("success", [
  z.object({
    version: z.literal(1),
    success: z.literal(true),
    result: z.union([rawResultSchema, batchResultSchema, z.array(batchResultSchema)]),
  }),
  z.object({ version: z.literal(1), success: z.literal(false), error: z.string().max(1000) }),
]);
export type GatewayResult = z.infer<typeof gatewayResponseSchema>;
export type GatewayRequest = z.infer<typeof queryRequestSchema> | z.infer<typeof batchRequestSchema>;

export interface D1PreparedBinding {
  bind(...values: D1Value[]): D1PreparedBinding;
  raw(options?: { columnNames?: boolean }): Promise<D1Value[][]>;
  all(): Promise<D1BatchResult>;
  run(): Promise<D1BatchResult>;
}
export interface D1Binding {
  prepare(sql: string): D1PreparedBinding;
  batch(statements: D1PreparedBinding[]): Promise<D1BatchResult[]>;
}
export function validateStatement(value: D1Statement): D1Statement {
  return statementSchema.parse(value);
}

export async function readBoundedText(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!stream) {
    throw new Error("missing_body");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Never return arbitrary SQLite errors: they can contain SQL literals or bound data. */
export function safeDatabaseError(error: Error): string {
  const constraint = error.message.match(
    /(?:UNIQUE|PRIMARY KEY|NOT NULL) constraint failed: [A-Za-z_]\w*\.[A-Za-z_]\w*(?:, [A-Za-z_]\w*\.[A-Za-z_]\w*)*/,
  )?.[0];
  if (constraint) {
    return `D1_ERROR: ${constraint}`;
  }
  if (error.message.includes("FOREIGN KEY constraint failed")) {
    return "D1_ERROR: FOREIGN KEY constraint failed";
  }
  if (error.message.includes("CHECK constraint failed")) {
    return "D1_ERROR: CHECK constraint failed";
  }
  return "D1 query failed";
}
