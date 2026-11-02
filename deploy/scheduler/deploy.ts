import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const revisionPattern = /^[0-9a-f]{40}$/;

export function deploymentRevision(ciRevision: string | undefined, checkoutRevision: string): string {
  if (!revisionPattern.test(checkoutRevision)) {
    throw new Error("Git checkout must have a complete lowercase commit SHA");
  }
  if (ciRevision === undefined) {
    return checkoutRevision;
  }
  if (!revisionPattern.test(ciRevision)) {
    throw new Error("WORKERS_CI_COMMIT_SHA must be a complete lowercase commit SHA");
  }
  if (ciRevision !== checkoutRevision) {
    throw new Error("WORKERS_CI_COMMIT_SHA does not match the checked-out commit");
  }
  return ciRevision;
}

export function deploymentArguments(revision: string, configPath: string, args: string[]): string[] {
  if (!revisionPattern.test(revision)) {
    throw new Error("Deployment revision is invalid");
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error("Only --dry-run is supported; Worker, config and revision are fixed by this script");
  }
  return ["exec", "wrangler", "deploy", "--config", configPath, "--var", `APP_REVISION:${revision}`, ...args];
}

function main(): void {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const checkoutRevision = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  const revision = deploymentRevision(process.env.WORKERS_CI_COMMIT_SHA, checkoutRevision);
  const args = deploymentArguments(
    revision,
    resolve(repository, "deploy/scheduler/wrangler.jsonc"),
    process.argv.slice(2),
  );
  // Only the public commit identifier is logged. Wrangler reads its own credentials.
  console.log(JSON.stringify({ event: "usc_scheduler_deploy", revision, dryRun: args.includes("--dry-run") }));
  const result = spawnSync("pnpm", args, { cwd: repository, stdio: "inherit" });
  if (result.error) {
    throw new Error("Could not start Wrangler deployment");
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Scheduler deployment failed");
    process.exitCode = 1;
  }
}
