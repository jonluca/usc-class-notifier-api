import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getPostgresPoolMax,
  getPrismaCliDatabaseUrl,
  getPrismaRuntimeDatabaseUrl,
  normalizePostgresSslMode,
} from "./postgresConfig.ts";

const pooledUrl = "postgresql://user:password@pool.example.test:5432/app?sslmode=require";
const directUrl = "postgresql://user:password@direct.example.test:5432/app?sslmode=require";

describe("PostgreSQL configuration", () => {
  it("uses the direct URL for Prisma CLI operations", () => {
    assert.equal(
      getPrismaCliDatabaseUrl({
        POSTGRES_PRISMA_URL: pooledUrl,
        POSTGRES_URL_NON_POOLING: directUrl,
      }),
      directUrl.replace("sslmode=require", "sslmode=verify-full"),
    );
  });

  it("uses the pooled URL for application queries", () => {
    assert.equal(
      getPrismaRuntimeDatabaseUrl({
        POSTGRES_PRISMA_URL: pooledUrl,
        POSTGRES_URL_NON_POOLING: directUrl,
      }),
      pooledUrl.replace("sslmode=require", "sslmode=verify-full"),
    );
  });

  it("falls back when only one database URL is configured", () => {
    assert.equal(
      getPrismaCliDatabaseUrl({ POSTGRES_PRISMA_URL: pooledUrl }),
      pooledUrl.replace("sslmode=require", "sslmode=verify-full"),
    );
    assert.equal(
      getPrismaRuntimeDatabaseUrl({ POSTGRES_URL_NON_POOLING: directUrl }),
      directUrl.replace("sslmode=require", "sslmode=verify-full"),
    );
  });

  it("preserves node-postgres's current TLS verification behavior", () => {
    assert.equal(
      normalizePostgresSslMode("postgresql://user:password@example.test/app?sslmode=verify-ca"),
      "postgresql://user:password@example.test/app?sslmode=verify-full",
    );
    assert.equal(
      normalizePostgresSslMode("postgresql://user:password@example.test/app?sslmode=require&uselibpqcompat=true"),
      "postgresql://user:password@example.test/app?sslmode=require&uselibpqcompat=true",
    );
  });

  it("keeps serverless pools small while allowing an explicit override", () => {
    assert.equal(getPostgresPoolMax({ VERCEL: "1" }), 5);
    assert.equal(getPostgresPoolMax({}), 10);
    assert.equal(getPostgresPoolMax({ POSTGRES_POOL_MAX: "12", VERCEL: "1" }), 12);
    assert.throws(() => getPostgresPoolMax({ POSTGRES_POOL_MAX: "0" }), /integer between 1 and 100/);
    assert.throws(() => getPostgresPoolMax({ POSTGRES_POOL_MAX: "many" }), /integer between 1 and 100/);
  });
});
