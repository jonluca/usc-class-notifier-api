import "dotenv/config";
import "@/server/logger";
import { PrismaClient } from "@app/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { getPostgresPoolMax, getPrismaRuntimeDatabaseUrl } from "@/server/postgresConfig.ts";
import { getDatabaseConfiguration } from "./d1/config.ts";
import { createRemoteD1PrismaClient } from "./d1/client.ts";

const createPostgresPrismaClient = () => {
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

export type PrismaClientType = ReturnType<typeof createPostgresPrismaClient>;

const databaseConfiguration = getDatabaseConfiguration(process.env);
const createPrismaClient = (): PrismaClientType =>
  databaseConfiguration.provider === "d1"
    ? createRemoteD1PrismaClient(databaseConfiguration)
    : createPostgresPrismaClient();

declare global {
  var prisma: PrismaClientType | undefined;
  var prismaProvider: string | undefined;
}

const providerKey = databaseConfiguration.provider === "d1" ? `d1:${databaseConfiguration.gatewayUrl}` : "postgres";
export const prisma: PrismaClientType =
  globalThis.prisma && (globalThis.prismaProvider ?? "postgres") === providerKey
    ? globalThis.prisma
    : createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
  globalThis.prismaProvider = providerKey;
}
