# USC PostgreSQL → D1 migration

The application keeps PostgreSQL as its default provider. These tools prepare a consistent, private snapshot and verify an isolated D1 destination. They do not change `DATABASE_PROVIDER`, stop application writers, create a Cloudflare database, delete a database, or run a remote import automatically. Development and synthetic tests do not export production customer data.

## Preconditions and ownership

Use the repository's supported Node version with `node:sqlite`, install dependencies, and generate both Prisma clients. Keep the PostgreSQL schema/migrations intact. The D1 schema is separate at `prisma/d1/schema.prisma`.

The destination must be a **new, empty D1 database** with a verified account ID, database UUID, and name. Use a token scoped to D1 in the intended account. Reading the target needs D1 read permission; the separately executed import needs D1 edit permission. Set credentials in the process environment or the existing ignored local environment file, never in command arguments, shell history, source control, or a chat transcript. The PostgreSQL exporter prefers `POSTGRES_URL_NON_POOLING`, then `POSTGRES_PRISMA_URL`.

USC's current PostgreSQL server is shared with other products. Moving this database alone does not delete that server, its provisioned volume, or the cluster/platform charges.

## Snapshot contract

- One PostgreSQL connection uses `REPEATABLE READ READ ONLY`. All four application tables and the distinct payment-reference set come from the same MVCC snapshot.
- A server-side cursor reads at most 5,000 rows at a time. Each table is sorted once by its primary key with PostgreSQL `COLLATE "C"`; verification uses SQLite binary order. SQL statements have a 30-second timeout; an idle transaction expires after 120 seconds. A failed export is abandoned rather than resumed against a different snapshot.
- The four tables are `Student`, `ClassInfo`, `WatchedSection`, and `NotificationSent`. IDs, strings, nulls, and boolean values are preserved. PostgreSQL timestamps are selected as decimal epoch milliseconds in SQL under UTC, bypassing node-postgres's local-time `Date` conversion. Source timestamp precision above milliseconds or non-integral values fail rather than truncate.
- Rows are canonical fixed-column-order JSON arrays, hashed with SHA-256 in binary primary-key order. The manifest records counts, digests, timestamp ranges/null coverage, and leading-zero string counts. It includes a source-identity hash, PostgreSQL snapshot identifier, and hashes of every SQL file. It contains no credential or customer-row sample.
- SQL uses UTF-8 hex literals cast to TEXT, preserving quotes, newlines, Unicode, and leading-zero payment references. Inserts are bounded to 64,000 bytes and at most 100 scalar values. Each data file is at most roughly 8 MiB; private file writes are buffered in roughly 256 KiB blocks without changing individual SQL statements. An unusually large single row fails with its contents withheld; it is never truncated.
- All artifacts go below `scripts/d1/.private/`, which is ignored by Git. Directories must be mode 0700 and files are created exclusively at mode 0600. No overwrite/resume option exists. Failed snapshots have no completed manifest. SQL, SQLite files, and private error logs still contain sensitive data; keep them on encrypted storage with restricted backups and remove exact snapshot directories when retention is no longer needed.

## 1. Validate tooling using synthetic records

```sh
pnpm exec tsx --test scripts/d1/migration.test.ts
pnpm typecheck
```

The focused tests cover a non-UTC timezone, exact milliseconds/nulls/leading zeros, special text, historical cross-semester payment-reference duplicates, new-reference guards, foreign-key failures, incomplete/tampered snapshots, target identity/nonempty checks, and bounded read retries. They use synthetic records and remove their private temporary directories.

## 2. Export and rehearse locally

Set the verified source hostname and database name below. They are deliberate source-identity checks, not connection credentials. The command actually reads/export customer data when executed against production; use a rehearsal source first.

```sh
pnpm exec tsx scripts/d1/export.ts \
  --name rehearsal-2026-11-01 \
  --expect-host VERIFIED_POSTGRES_HOST \
  --expect-database VERIFIED_USC_DATABASE

pnpm exec tsx scripts/d1/verify.ts \
  --snapshot scripts/d1/.private/rehearsal-2026-11-01
```

The second command creates a new local `rehearsal.sqlite`, imports the snapshot, and verifies every table's count and digest, actual SQLite storage types, and all foreign keys. `PaymentReference` must exactly match the source's distinct historical `paidId` strings. Its successful `rehearsal.json` binds to the manifest hash. Reusing the same rehearsal file is refused; choose a fresh snapshot name after correcting any issue. Do not inspect SQL or customer rows through console commands when troubleshooting.

Import order is mandatory:

1. `0001_schema.sql` creates the four tables plus `PaymentReference` and `D1Invariant`.
2. Import Student → ClassInfo → WatchedSection → NotificationSent.
3. `0002_payment_reference_guards.sql` seeds **distinct historical** payment references, then installs insert/change guards. Historical duplicates across semesters remain valid; future reuse, including reuse after a watch is deleted, is prevented.

Do not apply both schema migrations before importing historical data. The guard would reject valid legacy duplicates. Do not disable the guards once writers are enabled.

## 3. Prepare a pinned import plan

Substitute the exact intended **empty** D1 target. This command only writes private local plan files; it makes no API request and performs no import.

```sh
pnpm exec tsx scripts/d1/import-plan.ts \
  --snapshot scripts/d1/.private/rehearsal-2026-11-01 \
  --account CLOUDFLARE_ACCOUNT_ID \
  --database D1_DATABASE_UUID \
  --name D1_DATABASE_NAME
```

Review the pinned identity in `target.json` and the generated `import-reviewed.sh`. The plan uses a private Wrangler config, not whichever deployment binding happens to be active. It first checks the live account/UUID/name and refuses a database containing application tables or a migration ledger. It creates an exclusive `import.started` marker, applies schema migration 0001 through native Wrangler migrations, imports data files, then applies migration 0002 through native Wrangler migrations. Separate staged migration directories keep Wrangler's normal `d1_migrations` ledger correct without enabling guards too early. Do not replace this sequence with a blanket `d1 migrations apply` against the full directory before loading data.

The script below is the **remote write step**. Run it only for the planned rehearsal/final destination:

```sh
sh scripts/d1/.private/rehearsal-2026-11-01/import-reviewed.sh
```

Wrangler output is redirected to mode 0600 private logs because failures can include SQL. The wrapper prints only aggregate progress/errors and never echoes those logs. There is no automatic retry for imports with an uncertain outcome. On interruption, leave production on PostgreSQL, inspect the exact target privately, and prefer a fresh empty destination and a fresh plan. The tools do not drop, truncate, clear a partial target, or guess which file committed.

## 4. Compare the remote destination while it has no writers

The generated script finishes with the following read-only verification. It may also be run independently:

```sh
pnpm exec tsx scripts/d1/target.ts \
  --snapshot scripts/d1/.private/rehearsal-2026-11-01 \
  --account CLOUDFLARE_ACCOUNT_ID \
  --database D1_DATABASE_UUID \
  --name D1_DATABASE_NAME \
  --verify
```

It checks identity, foreign keys, SQLite types, both payment-reference guards, the empty invariant table, and each full table's count/digest. Reads are sequential, paginated at 5,000 rows, and throttled to at most one API request per 300 ms. Network/429/502/503/504 failures have at most three retries; `Retry-After` is honored up to 60 seconds, with longer cooldowns stopping the command. Responses are bounded to 20 MiB. Authorization failures and unknown writes are not retried. Do not enable D1 writers during comparison.

This proves snapshot equivalence, not application compatibility. Also validate the deployed D1 read path against PostgreSQL for authentication/session lookups, current-semester catalog/search, active watches, payment status, and notification eligibility. Compare aggregate outcomes or opaque hashes; do not log student data. Exercise payment/notification transaction behavior against synthetic accounts in the isolated destination before accepting it for cutover.

## 5. Final snapshot and cutover

A rehearsal snapshot is stale as soon as PostgreSQL accepts another write. Repeat export → local rehearsal → import → remote verification with a new final snapshot and empty destination during a controlled write-quiescence window.

Before taking that final snapshot:

- Inventory and pause **every** USC writer: web/API mutation paths, the Northflank monitor, notification delivery, Gmail/Venmo reconciliation, scheduled/catalog refreshes, manual backfills, and administrative scripts. A code deployment flag alone does not quiesce another deployment or a running job.
- Let in-flight notifications/payment transactions finish. Reconcile any provider-side send with an uncertain acknowledgement; do not reset claims or resend messages solely to make the migration proceed. Account for outstanding notification-claim leases and retain their exact values in the snapshot.
- Verify the pause across every deployment and observe stable write counters/queues. The exporter itself does not enforce application maintenance mode or block concurrent writers. MVCC consistency cannot capture writes committed after its snapshot begins.

Keep both destinations without writers while the final import and full comparison run. Record the final snapshot ID, target identity, runtime build, and successful comparisons. Deploy the authenticated gateway with its `DB` binding pinned to the verified D1 database and its `D1_GATEWAY_TOKEN` Worker secret set. On every intended Node runtime, configure `D1_GATEWAY_URL`, the matching `D1_GATEWAY_TOKEN`, and **`DATABASE_PROVIDER=d1`** as described in `deploy/d1-gateway/README.md`; the application does not need a Cloudflare account API token. Preserve the PostgreSQL connection and backup for recovery. Bring up one monitor and the web/API intentionally; avoid simultaneous PostgreSQL and D1 writers or duplicate schedulers. Verify current-semester monitoring, new/changed watches, payment-reference uniqueness, payment processing, and notification claim/finalization before declaring completion.

Do not change the PostgreSQL default in source, delete the shared database, rotate unrelated credentials, or deprovision shared infrastructure as part of this snapshot workflow.

## Rollback boundary

Before D1 accepts any writes, keep writers paused and restore the PostgreSQL runtime configuration if needed; the original database remains authoritative.

**After the first D1 write, switching `DATABASE_PROVIDER` back is not a safe rollback.** PostgreSQL is then missing new/changed watches, payments, notification outcomes, claims, and permanent reference reservations. Quiesce writers again, export/reconcile the D1 changes into PostgreSQL with correct timestamp/boolean conversions and provider-send outcomes, verify both datasets, and only then switch. No automatic reverse replication or reconciliation tool is supplied here. Preserve the D1 data and recovery window until that decision is complete.

## Platform references

D1 limits include 100,000-byte SQL statements, 100 bound parameters, 2 MB rows/strings, and 30-second query/batch execution. The exporter is intentionally stricter. Storage layouts differ between PostgreSQL and SQLite, so the PostgreSQL disk size is not an exact D1 size forecast. Imports and index maintenance consume D1 writes.

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Import/export guidance](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Wrangler execute and migrations commands](https://developers.cloudflare.com/d1/wrangler-commands/)

## Optional final delta after a live PostgreSQL backfill

To shorten the maintenance window, import and fully verify the initial snapshot into an isolated D1 database while PostgreSQL remains live. **Do not give any application or monitor write access to that D1 destination yet.** Then quiesce all PostgreSQL writers, take a fresh final snapshot, and complete its local rehearsal as above. The initial and final snapshots must have the same source-identity hash.

```sh
pnpm exec tsx scripts/d1/delta.ts \
  --base scripts/d1/.private/INITIAL_SNAPSHOT \
  --final scripts/d1/.private/FINAL_SNAPSHOT \
  --max-changes 100
```

This command only reads the two private SQLite rehearsals. It recomputes every table's complete canonical digest, checks storage types and foreign keys, and merges primary-key-ordered rows to find exact inserts, updates, and deletes. It writes one exclusive mode 0600 `delta-from-BASE_SNAPSHOT_UUID.json` inside the final snapshot directory. The plan contains full before/after row values and must be treated as customer data. Console output contains only the plan path and change counts.

The plan includes both snapshot IDs and manifest hashes, both full table summaries, an explicit `preCutoverOnly` restriction, and at most 100 changed rows **including PaymentReference**. Larger deltas fail without a partial plan; use another reviewed strategy or a full final import. Preparing a plan does not apply it. The atomic remote application must independently check target identity, the initial backfill's proven baseline, expected before-values/counts, and the final after-values/counts/foreign keys. Trigger suspension and restoration must be inside that same successful native D1 transaction, never separate remote calls. Reject a generated statement batch above the platform's supported bound before sending it.

Before D1 has ever accepted application writes, the reference registry may be aligned to exactly the final PostgreSQL distinct-reference set. After D1 has accepted a write, deleted/changed watches can leave permanent reserved references that must be retained. This pre-cutover delta workflow is then invalid; do not use it as ongoing synchronization or rollback tooling. Keep PostgreSQL writers paused until the final delta succeeds and the intended D1 runtime is ready.

For this cutover, the API uses `USC_MAINTENANCE_MODE=1` to block all application routes, including write-capable GETs; `/api/health` remains a read-only provider/revision check. The monitor admits no jobs in maintenance mode and handles SIGTERM with a 60-second drain; configure a platform grace period of at least 90 seconds.

After pausing writers, `installSourceFence` in `scripts/d1/fence.ts` locks all four PostgreSQL tables before checking active notification claims, then atomically installs always-enabled statement triggers rejecting INSERT/UPDATE/DELETE/TRUNCATE. This also fences old immutable deployment URLs. Read-only exports remain available. Keep this fence on the retired PostgreSQL source after D1 starts accepting writes.

`applyDelta` in `scripts/d1/apply-delta.ts` requires explicit pinned snapshot/source/hash proof and the verified baseline. It checks before/after values, counts, foreign keys and restored reference guards within one native atomic batch. An uncertain response triggers read-only reconciliation, never a write retry. Keep writers paused unless its receipt is `applied` or `after_state_verified`. Only then enable D1 and clear maintenance on the API and single scheduler.
