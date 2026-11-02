import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import test, { type TestContext } from "node:test";
import type { NextApiRequest, NextApiResponse } from "next";
import { createD1PrismaClient } from "@/server/d1/client";
import { createRemoteD1Binding } from "@/server/d1/remote";
import { queryRequestSchema } from "@/server/d1/protocol";
import { isMaintenanceMode } from "@/server/maintenance";
import { createHealthHandler } from "../pages/api/health";

interface HealthBody {
  ready: boolean;
  databaseProvider: "d1" | "postgres";
  maintenance: boolean;
  revision: string | null;
}
interface RecordedResponse {
  status: number;
  body?: HealthBody;
  headers: Map<string, string>;
}

function responseRecorder() {
  const recorded: RecordedResponse = {
    status: 0,
    headers: new Map(),
  };
  const response: NextApiResponse<HealthBody> = Object.assign(new ServerResponse(new IncomingMessage(new Socket())), {
    setHeader(name: string, value: string | number | readonly string[]) {
      recorded.headers.set(name, String(value));
      return response;
    },
    status(value: number) {
      recorded.status = value;
      return response;
    },
    json(value: HealthBody) {
      recorded.body = value;
      return response;
    },
    end() {
      return response;
    },
    send: () => assert.fail("health should use JSON responses"),
    redirect: () => assert.fail("health must not redirect"),
    setDraftMode: () => assert.fail("health must not change draft mode"),
    setPreviewData: () => assert.fail("health must not set preview data"),
    clearPreviewData: () => assert.fail("health must not clear preview data"),
    revalidate: async () => assert.fail("health must not trigger revalidation"),
  });
  return { response, recorded };
}

function fixture(context: TestContext, blocked: "none" | "lookup" | "database" = "none") {
  const statements: string[] = [];
  const binding = createRemoteD1Binding({
    gatewayUrl: "https://local.invalid",
    token: "synthetic-health-test-token-not-a-production-secret",
    fetcher: async (request) => {
      // No network: the real Prisma adapter and wire encoder stop at this fixture.
      assert.equal(new URL(request.url).pathname, "/v1/d1/query");
      const payload = queryRequestSchema.parse(await request.json());
      assert.equal(payload.mode, "raw");
      assert.match(payload.statement.sql, /^SELECT\b/);
      statements.push(payload.statement.sql);
      if (payload.statement.sql.trim() === "SELECT 1") {
        if (blocked === "database") {
          return new Response("unavailable", { status: 502 });
        }
        return Response.json({ version: 1, success: true, result: [["1"], [1]] });
      }
      // The regression requires the actual signup-shaped SQL, including the
      // optimizer's tautology which triggered the managed SQL-injection rule.
      assert.match(payload.statement.sql, /FROM [`"]main[`"]\.[`"]ClassInfo[`"]/);
      assert.match(payload.statement.sql, /1\s*=\s*1/);
      assert.match(payload.statement.sql, /[`"]section[`"]\s*=\s*\?/);
      assert.match(payload.statement.sql, /[`"]semester[`"]\s*=\s*\?/);
      assert.deepEqual(payload.statement.params, ["__health_probe__", "00000", 1, 0]);
      if (blocked === "lookup") {
        return new Response("<html>synthetic edge block; private diagnostic must not escape</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        });
      }
      return Response.json({ version: 1, success: true, result: [["id", "isCancelled"]] });
    },
  });
  const database = createD1PrismaClient(binding);
  context.after(() => database.$disconnect());
  const handler = createHealthHandler(database);
  return {
    statements,
    async call(method = "GET") {
      const { response, recorded } = responseRecorder();
      // SAFETY: health reads only the HTTP method from the request.
      await handler({ method } as NextApiRequest, response);
      return recorded;
    },
  };
}

const state = () => ({
  databaseProvider: "d1",
  maintenance: isMaintenanceMode(),
  revision: process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_REVISION || null,
});

test("health verifies the signup composite lookup without requiring a real class", async (context) => {
  const run = fixture(context);
  const response = await run.call();
  assert.equal(run.statements.length, 2);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(response.body, { ready: true, ...state() });
});

test("health returns 503 when SELECT 1 passes but the signup lookup receives an edge 403", async (context) => {
  const run = fixture(context, "lookup");
  const response = await run.call();
  assert.equal(run.statements.length, 2);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(response.body, { ready: false, ...state() });
  assert.doesNotMatch(JSON.stringify(response.body), /diagnostic|Prisma|SELECT|403/);
});

test("health preserves the unavailable-database and GET-only contracts", async (context) => {
  const unavailable = fixture(context, "database");
  const response = await unavailable.call();
  assert.equal(unavailable.statements.length, 1);
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { ready: false, ...state() });
  const wrongMethod = fixture(context);
  const rejected = await wrongMethod.call("POST");
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("Allow"), "GET");
  assert.equal(rejected.body, undefined);
  assert.equal(wrongMethod.statements.length, 0);
});
