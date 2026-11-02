/** Local-only test fixture: synthetic data, real workerd D1, no cloud credentials. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { createD1PrismaClient } from "./client.ts";
import { createRemoteD1Binding } from "./remote.ts";

export async function createD1TestClient(options: { installGuards?: boolean } = {}) {
  const token = "local-test-only-token-not-a-production-secret";
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../../../deploy/d1-gateway/worker.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "usc-local-test" },
    bindings: { D1_GATEWAY_TOKEN: token },
  });
  const native = await mf.getD1Database("DB");
  // D1 exec splits input by lines; each complete migration statement is submitted
  // separately, while trigger bodies remain one statement.
  const schema = await readFile(new URL("../../../prisma/d1/migrations/0001_schema.sql", import.meta.url), "utf8");
  const plain = schema.replace(/^--.*$/gm, "");
  for (const statement of plain.split(";").filter((s) => s.trim())) {
    await native.prepare(statement).run();
  }
  async function installGuards() {
    const sql = await readFile(
      new URL("../../../prisma/d1/migrations/0002_payment_reference_guards.sql", import.meta.url),
      "utf8",
    );
    const statements = sql
      .replace(/^--.*$/gm, "")
      .split(/;\s*(?=CREATE TRIGGER|$)/)
      .filter((s) => s.trim());
    for (const statement of statements) {
      await native.prepare(statement).run();
    }
  }
  if (options.installGuards !== false) {
    await installGuards();
  }
  const binding = createRemoteD1Binding({
    gatewayUrl: "https://local.invalid",
    token,
    fetcher: async (request) => {
      const response = await mf.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    },
  });
  const database = createD1PrismaClient(binding);
  return {
    database,
    executor: binding,
    binding,
    native,
    installGuards,
    dispatch: async (request: Request) =>
      mf.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      }),
    dispose: async () => {
      await database.$disconnect();
      await mf.dispose();
    },
  };
}
