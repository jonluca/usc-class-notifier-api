import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("console forwarding preserves object and array messages", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import=tsx",
      "--input-type=module",
      "--eval",
      'import "./src/server/logger.ts"; console.log({ foo: "bar" }); console.log(["alpha", "beta"]);',
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.match(output, /\{"foo":"bar"\}/);
  assert.match(output, /\["alpha","beta"\]/);
});
