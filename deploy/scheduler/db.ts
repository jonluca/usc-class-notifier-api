import type { PrismaClientType } from "../../src/server/db.ts";
import { createD1PrismaClient } from "../../src/server/d1/client.ts";
import {
  registerD1Executor,
  getD1Executor,
  type D1BatchResult,
  type D1Executor,
  type D1Statement,
  type D1Value,
} from "../../src/server/d1/executor.ts";
import {
  MAX_BATCH_STATEMENTS,
  batchResultSchema,
  rawResultSchema,
  safeDatabaseError,
  validateStatement,
  type D1Binding,
  type D1PreparedBinding,
} from "../../src/server/d1/protocol.ts";

export type { PrismaClientType } from "../../src/server/db.ts";

/** Native binding only: no account token, HTTP gateway, retry or PostgreSQL fallback. */
export function createNativeD1Binding(native: D1Binding): D1Binding & D1Executor {
  async function execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new Error(error instanceof Error ? safeDatabaseError(error) : "D1 query failed");
    }
  }
  class Statement implements D1PreparedBinding {
    constructor(
      readonly sql: string,
      readonly params: D1Value[] = [],
    ) {
      validateStatement({ sql, params });
    }
    bind(...params: D1Value[]): Statement {
      return new Statement(this.sql, params);
    }
    nativeStatement(): D1PreparedBinding {
      return native.prepare(this.sql).bind(...this.params);
    }
    async raw(options?: { columnNames?: boolean }): Promise<D1Value[][]> {
      return execute(async () => rawResultSchema.parse(await this.nativeStatement().raw(options)));
    }
    async all(): Promise<D1BatchResult> {
      return execute(async () => batchResultSchema.parse(await this.nativeStatement().all()));
    }
    async run(): Promise<D1BatchResult> {
      return execute(async () => batchResultSchema.parse(await this.nativeStatement().run()));
    }
  }
  return {
    prepare: (sql) => new Statement(sql),
    async query<T>(sql: string, params: D1Value[] = []): Promise<T[]> {
      // SAFETY: native rows are checked as SQLite scalar records; the SQL caller owns its projection's field types.
      return (await new Statement(sql, params).all()).results as T[];
    },
    async batch(statements: (D1Statement | D1PreparedBinding)[]): Promise<D1BatchResult[]> {
      if (!statements.length || statements.length > MAX_BATCH_STATEMENTS) {
        throw new Error("Invalid D1 batch size");
      }
      const prepared = statements.map((statement) => {
        if (statement instanceof Statement) {
          return statement.nativeStatement();
        }
        if ("sql" in statement) {
          const { sql, params = [] } = validateStatement(statement);
          return new Statement(sql, params).nativeStatement();
        }
        throw new Error("D1 batch statement belongs to another binding");
      });
      // D1 executes this entire batch atomically. Never split it or retry an uncertain outcome.
      return execute(async () => (await native.batch(prepared)).map((result) => batchResultSchema.parse(result)));
    },
  };
}

const clients = new WeakMap<D1Binding, PrismaClientType>();
let activeClient: PrismaClientType | undefined;

/** Call at the start of every Worker entry point, before application functions run. */
export function initializeSchedulerDatabase(native: D1Binding): PrismaClientType {
  let client = clients.get(native);
  if (!client) {
    client = createD1PrismaClient(createNativeD1Binding(native));
    clients.set(native, client);
  }
  if (activeClient && activeClient !== client) {
    throw new Error("Scheduler D1 binding changed within one isolate");
  }
  activeClient = client;
  return client;
}

function database(): PrismaClientType {
  if (!activeClient) {
    throw new Error("Scheduler D1 database has not been initialized");
  }
  return activeClient;
}

// The entry point binds D1 before application functions use this proxy.
// SAFETY: every property is forwarded to the generated Prisma client, never PostgreSQL.
const proxyTarget = {} as PrismaClientType;
export const prisma = new Proxy(proxyTarget, {
  get(_target, property: keyof PrismaClientType) {
    const client = database();
    const value = client[property];
    return value instanceof Function ? value.bind(client) : value;
  },
});

// Application helpers look up the exported identity, not the underlying client.
registerD1Executor(prisma, {
  query: <T>(sql: string, params?: D1Value[]) => schedulerExecutor().query<T>(sql, params),
  batch: (statements) => schedulerExecutor().batch(statements),
});

function schedulerExecutor(): D1Executor {
  const executor = getD1Executor(database());
  if (!executor) {
    throw new Error("Scheduler D1 executor is unavailable");
  }
  return executor;
}
