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
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClientType | undefined;
};

export const prisma: PrismaClientType = globalForPrisma.prisma ?? baseClient;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
