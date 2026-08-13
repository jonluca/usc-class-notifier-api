interface PostgresEnvironment {
  readonly [key: string]: string | undefined;
  POSTGRES_POOL_MAX?: string;
  POSTGRES_PRISMA_URL?: string;
  POSTGRES_URL_NON_POOLING?: string;
  VERCEL?: string;
}

const SERVERLESS_POOL_MAX = 5;
const LONG_RUNNING_POOL_MAX = 10;

/**
 * Preserve node-postgres's current certificate-verifying behavior when its
 * legacy SSL aliases change semantics in pg v9.
 */
export const normalizePostgresSslMode = (connectionString: string | undefined): string | undefined => {
  if (!connectionString) {
    return undefined;
  }

  const url = new URL(connectionString);
  const sslMode = url.searchParams.get("sslmode");
  const usesLibpqCompatibility = url.searchParams.get("uselibpqcompat") === "true";
  if (!usesLibpqCompatibility && ["prefer", "require", "verify-ca"].includes(sslMode ?? "")) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
};

/** Prisma CLI operations should use the direct URL, matching Prisma 6's directUrl behavior. */
export const getPrismaCliDatabaseUrl = (environment: PostgresEnvironment): string | undefined =>
  normalizePostgresSslMode(environment.POSTGRES_URL_NON_POOLING || environment.POSTGRES_PRISMA_URL);

/** Application queries should prefer the runtime/pooler URL. */
export const getPrismaRuntimeDatabaseUrl = (environment: PostgresEnvironment): string | undefined =>
  normalizePostgresSslMode(environment.POSTGRES_PRISMA_URL || environment.POSTGRES_URL_NON_POOLING);

export const getPostgresPoolMax = (environment: PostgresEnvironment): number => {
  const configuredPoolMax = environment.POSTGRES_POOL_MAX?.trim();
  if (!configuredPoolMax) {
    return environment.VERCEL ? SERVERLESS_POOL_MAX : LONG_RUNNING_POOL_MAX;
  }

  const parsedPoolMax = Number(configuredPoolMax);
  if (!Number.isSafeInteger(parsedPoolMax) || parsedPoolMax < 1 || parsedPoolMax > 100) {
    throw new Error("POSTGRES_POOL_MAX must be an integer between 1 and 100");
  }
  return parsedPoolMax;
};
