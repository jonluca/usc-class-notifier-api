# USC scheduler on Cloudflare

This Worker replaces the continuously running Northflank `usc-soc-api` monitor. The web API stays on Vercel. Both use the same authoritative `usc-schedule-helper` D1 database; the Worker uses its native `DB` binding, while Vercel uses the authenticated D1 gateway. Worker deployment does not migrate or reset data.

## Build and deploy

Use the repository's pinned pnpm version and Node 26.12.1 (or a compatible supported Node release). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm d1:generate
pnpm scheduler:check
pnpm scheduler:deploy
```

`d1:generate` emits separate Node and Cloudflare Prisma clients. The Cloudflare client loads the query compiler as a static WASM module; do not substitute the Node client. Wrangler aliases remove PostgreSQL, Winston, dotenv, and the Node Twilio SDK. The AWS XML parser alias is also required: the browser variant uses `DOMParser`, which is unavailable in Workers.

Deploy from the intended committed checkout. `scheduler:deploy` reads `git HEAD`; in Cloudflare Builds it also validates `WORKERS_CI_COMMIT_SHA` and refuses a different checkout or malformed value. It passes the full revision to Wrangler as `APP_REVISION`, using an argument array, and propagates deployment failures. `pnpm scheduler:deploy --dry-run` exercises the same revision guard without uploading. Additional flags cannot override the Worker, config, or revision. This script does not commit files, run database migrations, change the scheduler control row, or copy authentication credentials.

For native Cloudflare Builds, connect the existing `jonluca/usc-class-notifier-api` repository to **usc-scheduler**, production branch **master**, repository root **/**. Use build command `pnpm d1:generate` and deploy command `pnpm scheduler:deploy`. Pin build variable `NODE_VERSION=26.12.1`; `packageManager` pins pnpm. Enable production-branch builds only. Use Cloudflare's managed build token, not a copied local Wrangler OAuth token. Build variables and runtime secrets are separate.

The runtime needs the existing Gmail app-password configuration (`GMAIL_IMAP_USER`, `GMAIL_IMAP_APP_PASSWORD`), SES credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`), Twilio configuration (`TWILIO_SID`, `TWILIO_TOKEN`, or `TWILIO_API_KEY_SID` plus `TWILIO_API_KEY_SECRET`, and `FROM_NUMBER`), the administrator alert destination `TO_NUMBER`, and a separate strong `SCHEDULER_TOKEN`. Keep secret values out of Git, command arguments, build logs, and copied diagnostic output. Existing Worker secrets are preserved across ordinary deployments.

## Scheduling and durable state

| Cron expression (UTC) | Work                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| `*/5 * * * *`         | Availability checks for watched departments and pending paid-notification pages |
| `2,17,32,47 * * * *`  | Gmail receipt reconciliation, in bounded pages                                  |
| `15 10 * * *`         | Full catalog refresh per department and scheduler-history pruning               |

The producer sends deterministic tasks to the `usc-scheduler` Queue. Consumers run one message per invocation, with concurrency bounded in Wrangler. Availability and paid notifications use pages of 10; Gmail pages contain at most 100 messages. Continuations are published before completing the current task so an uncertain queue response cannot silently lose remaining pages.

The daily catalog batch shares this queue with availability checks. Its department tasks can delay later polling while the batch drains; the five-minute Cron interval is not a notification-latency guarantee. Check `SchedulerRun.startedAt - scheduledAt` for availability tasks during catalog refreshes. If catalog work repeatedly adds more than one polling interval of waiting, move catalog tasks to a separate queue with its own small concurrency limit. Queue delivery attempts spent waiting for a scope lease do not consume the three-execution retry allowance for catalog and Gmail work.

`SchedulerRun` records aggregate outcomes, `SchedulerLease` prevents overlapping work in the same scope, and `SchedulerControl` controls admission. The lease lasts 20 minutes; old completed history is kept for at least 14 days. Stale tasks older than 24 hours are acknowledged without execution. Expired leases are reclaimable; do not manually delete dedupe records or turn a failed run into a completed run.

Cloudflare Queues can redeliver messages. Deterministic task IDs, durable claims, existing notification claims, and payment-reference guards protect application writes; external email/SMS delivery cannot be made transactional with D1. A timeout after provider acceptance can have an uncertain delivery outcome. SES and Twilio transports make one attempt, catalog/Gmail tasks have bounded immediate retries, and sending tasks retain the next-Cron retry cadence. Inspect provider delivery evidence before replaying uncertain sends.

## Controlled handoff

1. Apply the reviewed scheduler schema migration to the already-migrated D1 database. `0003_scheduler.sql` creates its control row with `enabled=0`. Verify the migration ledger; do not rerun the initial data import or all schema files manually.
2. Deploy the Worker and its two queues while the control row remains disabled. Existing cron events will enqueue no work. Authenticate `/health` and `/canary`; the canary checks native D1 and optionally one Gmail page without sending messages or applying payment writes.
3. Pause the Northflank monitor and wait for its actual application processes and claimed notification work to drain. Confirm no other old scheduler instance is running. Both schedulers must not independently send notifications during handoff.
4. Enable the D1 control row, then confirm ordinary availability, Gmail, paid-notification, and catalog task outcomes before deleting the old Northflank service. A manual authenticated dispatch can exercise a schedule without changing its cadence.
5. Verify Vercel health and D1 reads remain healthy. Remove only the retired scheduler service and its source linkage; retain shared infrastructure used by other applications.

The admission switch is a reviewed D1 SQL update, not a public HTTP endpoint:

```sql
UPDATE SchedulerControl SET enabled = 0 WHERE id = 'scheduler';
-- Enable only after the old scheduler has stopped:
UPDATE SchedulerControl SET enabled = 1 WHERE id = 'scheduler';
```

Disabling admission does not cancel already-running tasks. Queued messages retry while disabled and can eventually enter `usc-scheduler-failed`; prolonged maintenance requires queue/backlog inspection before resumption. Wait for active leases and actual task execution to settle before starting any replacement scheduler. Never purge queues merely to make health counters green.

## Health and recovery

All HTTP endpoints require `Authorization: Bearer <SCHEDULER_TOKEN>` and return `Cache-Control: no-store`:

- `GET /health`: revision, enabled state, aggregate runs, active/expired leases, dead jobs, and latest outcome per kind.
- `POST /canary` with `{"gmail":false}` or `{"gmail":true}`: read-only D1/native transport checks; no sends or application writes.
- `POST /dispatch` with `{"trigger":"five"}`, `{"trigger":"fifteen"}`, or `{"trigger":"daily"}`: enqueue the selected work only while enabled. This is operational work, not a read-only probe.

Use the health revision to confirm the intended deploy. Inspect failed runs, stale last-success timestamps, dead jobs, queue backlog, and the dead-letter queue. Logs and run summaries should contain aggregate counts and fixed error codes, never email bodies, payment references, recipients, credentials, or raw provider responses. Gmail failures preserve the existing administrator SMS alert behavior, with one reserved alert attempt per task.

A Worker code rollback does not undo D1 writes or schema changes. Prefer a compatible earlier Worker version against the current D1 database. Disable admission first if the current version is unsafe, and reconcile in-flight notification attempts before resuming.

The retired PostgreSQL database's native backup is a historical recovery archive, not the current database. Once D1 accepts writes, restoring that archive and pointing services at it would lose later changes and could resend notifications or reuse payment references. Restore it into an isolated database for inspection, then reconcile all later D1 changes and provider outcomes before any deliberate database rollback. Preserve the global payment-reference registry and notification-cycle/claim state. Never restore or drop the shared PostgreSQL server or unrelated databases to recover USC.

## Local verification

```sh
pnpm exec tsx --test 'deploy/scheduler/*.test.ts'
pnpm typecheck
pnpm lint
pnpm scheduler:check
```

The adapter tests run actual local workerd/D1, including atomic rollback, millisecond dates, Prisma relations, static WASM loading, email rendering, SES signing, and SMS form requests. Notification provider responses are simulated; those tests send no real messages. Production transport readiness still requires the authenticated, read-only canary.

References: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/), [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).
