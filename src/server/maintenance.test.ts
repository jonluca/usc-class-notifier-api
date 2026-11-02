import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { isMaintenanceMode } from "./maintenance";

function maintenance(context: TestContext, value: string) {
  const previous = process.env.USC_MAINTENANCE_MODE;
  process.env.USC_MAINTENANCE_MODE = value;
  context.after(() => {
    if (previous === undefined) {
      delete process.env.USC_MAINTENANCE_MODE;
    } else {
      process.env.USC_MAINTENANCE_MODE = previous;
    }
  });
}

test("maintenance gates write-capable GETs, POSTs and pages while retaining read-only health", (context) => {
  maintenance(context, "1");
  for (const path of [
    "/api/data/user.verifyByKey",
    "/api/texts-enabled",
    "/api/refresh",
    "/verify",
    "/watch",
    "/dashboard",
    "/admin",
    "/",
  ]) {
    for (const method of ["GET", "POST"]) {
      const result = proxy(new NextRequest(`https://example.invalid${path}`, { method }));
      assert.equal(result.status, 503);
      assert.equal(result.headers.get("Cache-Control"), "no-store");
    }
  }
  assert.equal(proxy(new NextRequest("https://example.invalid/api/health")).headers.get("x-middleware-next"), "1");
});

test("normal mode permits public routes and retains admin authentication", (context) => {
  maintenance(context, "0");
  assert.equal(proxy(new NextRequest("https://example.invalid/")).headers.get("x-middleware-next"), "1");
  assert.equal(proxy(new NextRequest("https://example.invalid/admin")).status, 401);
  assert.equal(isMaintenanceMode({}), false);
  assert.equal(isMaintenanceMode({ USC_MAINTENANCE_MODE: "true" }), true);
});
