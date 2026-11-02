import assert from "node:assert/strict";
import test from "node:test";
import { getDatabaseConfiguration } from "./config.ts";

test("Postgres stays default and D1 fails closed on incomplete or insecure configuration", () => {
  assert.deepEqual(getDatabaseConfiguration({}), { provider: "postgres" });
  assert.deepEqual(getDatabaseConfiguration({ DATABASE_PROVIDER: "postgresql" }), { provider: "postgres" });
  assert.throws(() => getDatabaseConfiguration({ DATABASE_PROVIDER: "unknown" }));
  assert.throws(() => getDatabaseConfiguration({ DATABASE_PROVIDER: "d1" }));
  const env = { DATABASE_PROVIDER: "d1", D1_GATEWAY_URL: "https://gateway.example", D1_GATEWAY_TOKEN: "x".repeat(40) };
  assert.equal(getDatabaseConfiguration(env).provider, "d1");
  for (const url of [
    "http://gateway.example",
    "https://user:pass@gateway.example",
    "https://gateway.example/path",
    "https://gateway.example?token=x",
  ]) {
    assert.throws(() => getDatabaseConfiguration({ ...env, D1_GATEWAY_URL: url }));
  }
});
