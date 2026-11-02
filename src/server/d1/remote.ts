import type { D1BatchResult, D1Executor, D1Statement, D1Value } from "./executor.ts";
import {
  MAX_BATCH_STATEMENTS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  readBoundedText,
  validateStatement,
  gatewayResponseSchema,
  rawResultSchema,
  batchResultSchema,
  type D1Binding,
  type D1PreparedBinding,
  type QueryMode,
  type GatewayRequest,
} from "./protocol.ts";
import { z } from "zod";

type Fetcher = (request: Request) => Promise<Response>;

/** No retries: a lost response may follow a committed write. Callers must reconcile explicitly. */
export function createRemoteD1Binding(options: {
  gatewayUrl: string;
  token: string;
  fetcher?: Fetcher;
}): D1Binding & D1Executor {
  const fetcher = options.fetcher ?? ((request: Request) => fetch(request));
  async function request(path: string, payload: GatewayRequest) {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
      throw new Error("D1 request too large");
    }
    const response = await fetcher(
      new Request(`${options.gatewayUrl}${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(35_000),
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body,
      }),
    );
    let result;
    try {
      result = gatewayResponseSchema.parse(JSON.parse(await readBoundedText(response.body, MAX_RESPONSE_BYTES)));
    } catch {
      throw new Error(`Invalid D1 gateway response (${response.status})`);
    }
    if (!response.ok || !result.success) {
      const error = !result.success ? result.error : "";
      const message =
        /^(D1_ERROR: (?:UNIQUE|PRIMARY KEY|NOT NULL|FOREIGN KEY|CHECK) constraint failed(?:: [A-Za-z_\w., ]+)?|D1 query failed)$/.test(
          error,
        )
          ? error
          : `D1 gateway request failed (${response.status})`;
      throw new Error(message);
    }
    return result.result;
  }
  class Statement implements D1PreparedBinding {
    constructor(
      readonly sql: string,
      readonly params: D1Value[] = [],
    ) {
      validateStatement({ sql, params });
    }
    bind(...values: D1Value[]): Statement {
      return new Statement(this.sql, values);
    }
    execute(mode: QueryMode) {
      return request("/v1/d1/query", { version: 1, mode, statement: { sql: this.sql, params: this.params } });
    }
    async raw(options?: { columnNames?: boolean }): Promise<D1Value[][]> {
      const rows = rawResultSchema.parse(await this.execute("raw"));
      return options?.columnNames ? rows : rows.slice(1);
    }
    async all(): Promise<D1BatchResult> {
      return batchResultSchema.parse(await this.execute("all"));
    }
    async run(): Promise<D1BatchResult> {
      return batchResultSchema.parse(await this.execute("run"));
    }
  }
  async function executeBatch(statements: D1Statement[]): Promise<D1BatchResult[]> {
    if (!statements.length || statements.length > MAX_BATCH_STATEMENTS) {
      throw new Error("Invalid D1 batch size");
    }
    const validated = statements.map(({ sql, params = [] }) => ({ sql, params }));
    return z.array(batchResultSchema).parse(await request("/v1/d1/batch", { version: 1, statements: validated }));
  }
  return {
    prepare: (sql) => new Statement(sql),
    async query<T>(sql: string, params: D1Value[] = []): Promise<T[]> {
      // SAFETY: network rows were parsed as SQLite scalar records; callers own the SQL projection's field types.
      return (await new Statement(sql, params).all()).results as T[];
    },
    async batch(statements: (D1Statement | D1PreparedBinding)[]): Promise<D1BatchResult[]> {
      return executeBatch(
        statements.map((statement) => {
          if (statement instanceof Statement) {
            return { sql: statement.sql, params: statement.params };
          }
          if ("sql" in statement) {
            return validateStatement(statement);
          }
          throw new Error("D1 batch statement belongs to another binding");
        }),
      );
    },
  };
}
