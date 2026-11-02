# Staged D1 gateway

This Worker provides authenticated database access for the existing Node API and
monitor. It is not a public application API. The Node applications receive only a
gateway token; they do not need a Cloudflare account API token.

PostgreSQL remains the default. The D1 application configuration is explicit:

```dotenv
DATABASE_PROVIDER=d1
D1_GATEWAY_URL=https://<reviewed-gateway-domain>
D1_GATEWAY_TOKEN=<random-secret-at-least-32-characters>
```

The gateway must receive the same `D1_GATEWAY_TOKEN` as a Worker secret and a `DB`
D1 binding. Its configuration deliberately contains a placeholder database UUID,
no route, and disabled workers.dev/preview URLs. Replace the UUID and add a
reviewed custom domain only during an authorized deployment. Do not put a token
in Wrangler configuration or expose it through a NEXT_PUBLIC environment variable.

`POST /v1/d1/query` accepts `{version:1,mode:"raw"|"all"|"run",statement:{sql,params}}`.
Raw responses retain the native column-name header, including empty result sets.
`POST /v1/d1/batch` accepts `{version:1,statements:[{sql,params}]}` and invokes one
native `DB.batch()`, preserving atomic rollback. Both require Bearer authentication.
Requests are capped at 2MB, responses at 8MB, batches at 256 statements, SQL at
100KB per statement, and parameters at 100 per statement. Constraint errors expose
only sanitized type/table/column information. No SQL, values, or credentials are
logged by the gateway. Its token grants database access and belongs only in trusted
server environments.

The remote client uses a 35-second deadline and never retries automatically: a
timeout can follow a committed mutation. Application operations must reconcile
their durable state before retrying. Provider errors do not fall back to PostgreSQL.

The separate Prisma client is generated from `prisma/d1/schema.prisma`; the normal
PostgreSQL schema and client are retained. Prisma D1's default ISO timestamp
encoding is overridden at the typed adapter boundary so every DateTime value,
including predicates, uses epoch milliseconds. The initial SQL migration also
uses integer millisecond defaults. Preserve that convention when generating future
migration diffs. Prisma `$transaction` and implicit transactions are rejected;
critical mutations use the registered `D1Executor.batch()` instead. For example,
an update with included relations needs a separate mutation and relation read,
or an explicitly designed atomic batch.

Migration order: apply `0001_schema.sql` to an empty destination, import the four
application tables, then apply `0002_payment_reference_guards.sql`. The latter
reserves every distinct historical reference while retaining legacy duplicate
assignments; new assignments are globally unique and reservations survive deletion.
`D1Invariant` supplies a CHECK constraint for conditional batch rollback. See
`docs/d1-migration.md` for the guarded export, rehearsal, import and verification
procedure. Do not run both direct SQL import and native migration application
without accounting for the migration ledger.

Local verification (no cloud deployment or account credentials):

```sh
pnpm install --frozen-lockfile
pnpm run d1:generate
pnpm exec tsx --test src/server/d1/config.test.ts src/server/d1/runtime.test.ts
pnpm run d1:gateway:check
```

The fixture in `src/server/d1/testing.ts` bundles this Worker and runs real D1 in
Miniflare. It creates synthetic data and disposes the runtime after each test.
