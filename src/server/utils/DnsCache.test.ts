import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { isFunction } from "lodash-es";
import CacheableLookup from "./DnsCache";

test("accepts agent methods created in another JavaScript realm", () => {
  const crossRealmCreateConnection: unknown = runInNewContext("(function createConnection() {})");
  assert.ok(isFunction(crossRealmCreateConnection));

  const agent = { createConnection: crossRealmCreateConnection };
  const cacheableLookup = new CacheableLookup({ fallbackDuration: 0 });

  cacheableLookup.install(agent);
  cacheableLookup.uninstall(agent);

  assert.equal(agent.createConnection, crossRealmCreateConnection);
});
