import "dotenv/config";
import "@/server/logger";
import { PrismaClient } from "@app/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { getPostgresPoolMax, getPrismaRuntimeDatabaseUrl } from "@/server/postgresConfig.ts";

const adapter = new PrismaPg({
  connectionString: getPrismaRuntimeDatabaseUrl(process.env)!,
  keepAlive: true,
  statement_timeout: undefined,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 60_000,
  max: getPostgresPoolMax(process.env),
});

const baseClient = new PrismaClient({
  adapter,
});

export type PrismaClientType = typeof baseClient;

declare global {
  var prisma: PrismaClientType | undefined;
}

export const prisma: PrismaClientType = globalThis.prisma ?? baseClient;

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}
