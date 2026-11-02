import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadArtifact, hashFile, rehearsalSchema, REPO, writePrivate } from "./artifact.ts";
import { validateIdentity, type TargetIdentity } from "./target.ts";
const shell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export async function prepareImport(snapshot: string, target: TargetIdentity): Promise<void> {
  validateIdentity(target);
  const { directory, manifest } = await loadArtifact(snapshot);
  const rehearsal = rehearsalSchema.parse(JSON.parse(await readFile(join(directory, "rehearsal.json"), "utf8")));
  if (
    rehearsal.snapshotId !== manifest.snapshotId ||
    rehearsal.manifestSha256 !== (await hashFile(join(directory, "manifest.json")))
  ) {
    throw new Error("A successful matching local rehearsal is required");
  }
  // Native staged migrations preserve Wrangler's ledger without installing the guards before historical data.
  const beforeDir = join(directory, "migrations-before-data");
  const afterDir = join(directory, "migrations-after-data");
  await mkdir(beforeDir, { mode: 0o700 });
  await mkdir(afterDir, { mode: 0o700 });
  const schema = await readFile(join(directory, manifest.files[0]!.name), "utf8");
  const guards = await readFile(join(directory, manifest.files.at(-1)!.name), "utf8");
  await writePrivate(join(beforeDir, "0001_schema.sql"), schema);
  await writePrivate(join(afterDir, "0001_schema.sql"), schema);
  await writePrivate(join(afterDir, "0002_payment_reference_guards.sql"), guards);
  const beforeConfig = join(directory, "wrangler-before-data.json");
  const afterConfig = join(directory, "wrangler-after-data.json");
  for (const [path, migrationsDirectory] of [
    [beforeConfig, beforeDir],
    [afterConfig, afterDir],
  ]) {
    await writePrivate(
      path!,
      JSON.stringify(
        {
          name: "usc-d1-private-migration",
          account_id: target.account,
          d1_databases: [
            {
              binding: "MIGRATION_TARGET",
              database_name: target.name,
              database_id: target.database,
              migrations_dir: migrationsDirectory,
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
  }
  const identity = `--account ${shell(target.account)} --database ${shell(target.database)} --name ${shell(target.name)}`;
  const check = `pnpm exec tsx scripts/d1/target.ts --snapshot ${shell(directory)} ${identity}`;
  const guarded = (command: string, label: string) =>
    `if ! ${command} > ${shell(join(directory, `import-${label}.log`))} 2>&1; then echo 'Import stopped; inspect the private log. Do not retry against this partial target.' >&2; exit 1; fi`;
  const script = [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    `cd ${shell(REPO)}`,
    ': "${CLOUDFLARE_API_TOKEN:?Set the intended account-scoped token without printing it}"',
    `export CLOUDFLARE_ACCOUNT_ID=${shell(target.account)}`,
    "# Review the pinned target identity before execution. This writes only that empty D1 target.",
    `${check} --empty`,
    `test ! -e ${shell(join(directory, "import.started"))}`,
    `set -C; : > ${shell(join(directory, "import.started"))}; set +C`,
    "# Logs can contain SQL/customer data on errors; they remain private and are never echoed.",
    guarded(
      `CI=true pnpm exec wrangler d1 migrations apply MIGRATION_TARGET --config ${shell(beforeConfig)} --remote`,
      "schema",
    ),
    ...manifest.files
      .filter((file) => file.phase === "data")
      .map((file, index) =>
        guarded(
          `pnpm exec wrangler d1 execute MIGRATION_TARGET --config ${shell(beforeConfig)} --remote --yes --file ${shell(join(directory, file.name))}`,
          String(index).padStart(4, "0"),
        ),
      ),
    guarded(
      `CI=true pnpm exec wrangler d1 migrations apply MIGRATION_TARGET --config ${shell(afterConfig)} --remote`,
      "guards",
    ),
    `${check} --verify`,
    "echo 'Snapshot import and comparison complete. Runtime cutover has NOT been performed.'",
    "",
  ].join("\n");
  await writePrivate(join(directory, "import-reviewed.sh"), script);
  await writePrivate(
    join(directory, "target.json"),
    JSON.stringify(
      { ...target, snapshotId: manifest.snapshotId, preparedAt: new Date().toISOString(), writesPerformed: false },
      null,
      2,
    ) + "\n",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      account: { type: "string" },
      database: { type: "string" },
      name: { type: "string" },
    },
    strict: true,
  });
  Promise.resolve()
    .then(async () => {
      if (!values.snapshot || !values.account || !values.database || !values.name) {
        throw new Error("snapshot/account/database/name required");
      }
      await prepareImport(values.snapshot, { account: values.account, database: values.database, name: values.name });
      console.log(JSON.stringify({ ok: true, importPlanPrepared: true, remoteCalls: 0, writesPerformed: false }));
    })
    .catch(() => {
      console.error("Import-plan preparation failed. No remote writes or customer data output.");
      process.exitCode = 1;
    });
}
