import { createTRPCRouter } from "./trpc";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { adminRouter } from "./routers/admin";
import { userRouter } from "@/server/api/routers/user";
import { catalogRouter } from "@/server/api/routers/catalog";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  admin: adminRouter,
  user: userRouter,
  catalog: catalogRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
export type RouterInput = inferRouterInputs<AppRouter>;
export type RouterOutput = inferRouterOutputs<AppRouter>;
