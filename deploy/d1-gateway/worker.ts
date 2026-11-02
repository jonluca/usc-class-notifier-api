import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  readBoundedText,
  safeDatabaseError,
  queryRequestSchema,
  batchRequestSchema,
  type D1Binding,
  type GatewayResult,
} from "../../src/server/d1/protocol.ts";
import type { D1BatchResult, D1Value } from "../../src/server/d1/executor.ts";

export interface GatewayEnvironment {
  DB: D1Binding;
  D1_GATEWAY_TOKEN: string;
}
function json(value: GatewayResult, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
async function authenticated(request: Request, expected: string): Promise<boolean> {
  if (!expected || expected.length < 32 || expected.length > 512) {
    return false;
  }
  const supplied = request.headers.get("authorization") ?? "";
  if (supplied.length > 1024) {
    return false;
  }
  const encoder = new TextEncoder();
  const [actual, wanted] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${expected}`)),
  ]);
  const a = new Uint8Array(actual),
    b = new Uint8Array(wanted);
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a[i]! ^ b[i]!;
  }
  return difference === 0;
}
export default {
  async fetch(request: Request, env: GatewayEnvironment): Promise<Response> {
    if (!(await authenticated(request, env.D1_GATEWAY_TOKEN))) {
      return json({ version: 1, success: false, error: "unauthorized" }, 401);
    }
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/v1/d1/query", "/v1/d1/batch"].includes(path)) {
      return json({ version: 1, success: false, error: "not_found" }, 404);
    }
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
      return json({ version: 1, success: false, error: "invalid_request" }, 400);
    }
    let execute: () => Promise<D1Value[][] | D1BatchResult | D1BatchResult[]>;
    try {
      const text = await readBoundedText(request.body, MAX_REQUEST_BYTES);
      if (path.endsWith("/batch")) {
        const value = batchRequestSchema.parse(JSON.parse(text));
        const statements = value.statements.map(({ sql, params }) => env.DB.prepare(sql).bind(...params));
        execute = () => env.DB.batch(statements);
      } else {
        const value = queryRequestSchema.parse(JSON.parse(text));
        const statement = env.DB.prepare(value.statement.sql).bind(...value.statement.params);
        if (value.mode === "raw") {
          execute = () => statement.raw({ columnNames: true });
        } else if (value.mode === "all") {
          execute = () => statement.all();
        } else {
          execute = () => statement.run();
        }
      }
    } catch {
      return json({ version: 1, success: false, error: "invalid_request" }, 400);
    }
    try {
      const result = await execute();
      const body = JSON.stringify({ version: 1, success: true, result });
      if (new TextEncoder().encode(body).length > MAX_RESPONSE_BYTES) {
        return json({ version: 1, success: false, error: "response_too_large" }, 413);
      }
      return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? safeDatabaseError(error) : "D1 query failed";
      return json({ version: 1, success: false, error: message }, message.startsWith("D1_ERROR:") ? 409 : 500);
    }
  },
};
