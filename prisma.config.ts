import "dotenv/config";
import { defineConfig } from "prisma/config";
import { getPrismaCliDatabaseUrl } from "./src/server/postgresConfig.ts";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: getPrismaCliDatabaseUrl(process.env),
  },
});
