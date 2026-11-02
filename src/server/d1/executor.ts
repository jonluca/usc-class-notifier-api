import type { PrismaClientType } from "../db.ts";
export type D1Value = string | number | null;
export interface D1Statement {
  sql: string;
  params?: D1Value[];
}
export interface D1BatchResult {
  results: Record<string, D1Value>[];
  meta: { changes: number };
}
export interface D1Executor {
  query<T>(sql: string, params?: D1Value[]): Promise<T[]>;
  batch(statements: D1Statement[]): Promise<D1BatchResult[]>;
}

type DatabaseIdentity = Pick<PrismaClientType, "classInfo">;
const executors = new WeakMap<DatabaseIdentity, D1Executor>();

export function registerD1Executor(database: DatabaseIdentity, executor: D1Executor): void {
  executors.set(database, executor);
}

export function getD1Executor(database: DatabaseIdentity): D1Executor | undefined {
  return executors.get(database);
}
