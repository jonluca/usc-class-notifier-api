import assert from "node:assert/strict";
import test from "node:test";
import { deploymentArguments, deploymentRevision } from "./deploy.ts";

const revision = "1234567890abcdef1234567890abcdef12345678";

test("deployment revision matches the checked-out source and malformed CI values never fall back", () => {
  assert.equal(deploymentRevision(undefined, revision), revision);
  assert.equal(deploymentRevision(revision, revision), revision);
  for (const supplied of ["", "main", "1234567", `${revision}\n`, `${revision};echo unsafe`, revision.toUpperCase()]) {
    assert.throws(() => deploymentRevision(supplied, revision), /complete lowercase commit SHA/);
  }
  assert.throws(() => deploymentRevision("f".repeat(40), revision), /does not match/);
  assert.throws(() => deploymentRevision(undefined, "HEAD"), /complete lowercase commit SHA/);
});

test("deploy command pins config and revision as arguments and rejects override flags", () => {
  const config = "/synthetic repository/deploy/scheduler/wrangler.jsonc";
  assert.deepEqual(deploymentArguments(revision, config, ["--dry-run"]), [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    config,
    "--var",
    `APP_REVISION:${revision}`,
    "--dry-run",
  ]);
  for (const args of [
    ["--name", "another-worker"],
    ["--var", "APP_REVISION:wrong"],
    ["--config", "other.jsonc"],
    ["--dry-run", "--dry-run"],
  ]) {
    assert.throws(() => deploymentArguments(revision, config, args), /Only --dry-run/);
  }
});
