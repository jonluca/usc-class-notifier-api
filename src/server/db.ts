import "dotenv/config";
import "@/server/logger";
import { PrismaClient } from "@app/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { getPostgresPoolMax, getPrismaRuntimeDatabaseUrl } from "@/server/postgresConfig.ts";

const createPrismaClient = () => {
  const adapter = new PrismaPg({
    connectionString: getPrismaRuntimeDatabaseUrl(process.env)!,
    keepAlive: true,
    statement_timeout: undefined,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 60_000,
    max: getPostgresPoolMax(process.env),
  });

  return new PrismaClient({ adapter });
};

export type PrismaClientType = ReturnType<typeof createPrismaClient>;

declare global {
  var prisma: PrismaClientType | undefined;
}

export const prisma: PrismaClientType = globalThis.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}
