import { z } from "zod";
import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient as D1PrismaClient } from "../../../prisma/generated-d1/client.ts";
import type { PrismaClientType } from "../db.ts";
import { registerD1Executor, type D1Executor } from "./executor.ts";
import { createRemoteD1Binding } from "./remote.ts";
import type { D1Binding } from "./protocol.ts";

const TRANSACTION_ERROR = "D1 Prisma transactions are disabled; use getD1Executor(database).batch() for atomic writes";

export function createD1PrismaClient(binding: D1Binding & D1Executor): PrismaClientType {
  // SAFETY: PrismaD1 uses only prepare/bind/raw/run, covered by real D1 integration
  // tests. Unsupported native dump/session/exec methods are not exposed remotely.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Third-party adapter requires unused native methods in its constructor type.
  const adapter = new PrismaD1(binding as unknown as ConstructorParameters<typeof PrismaD1>[0]);
  const connect = adapter.connect.bind(adapter);
  adapter.connect = async () => {
    const connection = await connect();
    // The stock adapter formats DateTime arguments as ISO text. Normalize using
    // Prisma's type metadata BEFORE that mapping so imports, predicates and all
    // application writes use the same epoch-millisecond representation. Never
    // inspect arbitrary string values (a String field may resemble a timestamp).
    const normalize = (query: Parameters<typeof connection.queryRaw>[0]) => ({
      ...query,
      args: query.args.map((value, index) => {
        if (value === null || query.argTypes[index]?.scalarType !== "datetime") {
          return value;
        }
        const milliseconds = z
          .union([
            z.number().int(),
            z.string().transform((input) => new Date(input).getTime()),
            z.date().transform((input) => input.getTime()),
          ])
          .parse(value);
        if (!Number.isSafeInteger(milliseconds)) {
          throw new Error("Invalid D1 DateTime argument");
        }
        return milliseconds;
      }),
    });
    const queryRaw = connection.queryRaw.bind(connection);
    const executeRaw = connection.executeRaw.bind(connection);
    connection.queryRaw = (query) => queryRaw(normalize(query));
    connection.executeRaw = (query) => executeRaw(normalize(query));
    // PrismaD1 otherwise silently ignores both explicit and implicit transactions.
    connection.startTransaction = async () => {
      throw new Error(TRANSACTION_ERROR);
    };
    return connection;
  };
  const client = new D1PrismaClient({ adapter });
  Object.defineProperty(client, "$transaction", {
    value: async () => {
      throw new Error(TRANSACTION_ERROR);
    },
    configurable: false,
    writable: false,
  });
  // SAFETY: both generated schemas share all application models. PostgreSQL-only
  // query features are routed explicitly by getD1Executor; transactions are blocked.
  const guarded = client as PrismaClientType;
  registerD1Executor(guarded, binding);
  return guarded;
}

export function createRemoteD1PrismaClient(configuration: { gatewayUrl: string; token: string }): PrismaClientType {
  return createD1PrismaClient(createRemoteD1Binding(configuration));
}
