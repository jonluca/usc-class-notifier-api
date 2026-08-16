/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { z, ZodError } from "zod/v4";
import type { PrismaClientType } from "@/server/db";
import { prisma } from "@/server/db";
import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from "next";
import type { IncomingMessage, ServerResponse } from "http";
import { transformer } from "@/server/api/transformer";
import type { Student } from "@app/prisma";
import logger from "@/server/logger";
import { getVerificationKey, isAuthenticated } from "@/server/auth";

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 */

export interface CreateContextOptions {
  res?: GetServerSidePropsContext["res"] | NextApiResponse | ServerResponse<IncomingMessage> | null;
  req?: GetServerSidePropsContext["req"] | NextApiRequest | IncomingMessage | null;
}

export interface InnerTrpcContext extends CreateContextOptions {
  prisma: PrismaClientType;
  user?: Student | null;
}
/**
 * This helper generates the "internals" for a tRPC context. If you need to use it, you can export
 * it from here.
 *
 * Examples of things you may need it for:
 * - testing, so we don't have to mock Next.js' req/res
 * - tRPC's `createSSGHelpers`, where we don't have req/res
 *
 * @see https://create.t3.gg/en/usage/trpc#-serverapitrpcts
 */
export const createInnerTRPCContext = async (opts: CreateContextOptions): Promise<InnerTrpcContext> => {
  const key = getVerificationKey(opts.req);

  const user = key ? await prisma.student.findUnique({ where: { verificationKey: key } }) : null;
  return {
    prisma,
    res: opts.res || null,
    req: opts.req || null,
    user,
  } as const;
};

/**
 * This is the actual context you will use in your router. It will be used to process every request
 * that goes through your tRPC endpoint.
 *
 * @see https://trpc.io/docs/context
 */
export const createTRPCContext = async (opts: {
  req: CreateContextOptions["req"];
  res?: CreateContextOptions["res"];
}): Promise<InnerTrpcContext> => {
  const { req, res } = opts;
  return createInnerTRPCContext({
    res,
    req,
  });
};

/**
 * 2. INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get typesafety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer,
  errorFormatter({ ["shape"]: errorResponse, error }) {
    return {
      ...errorResponse,
      data: {
        ...errorResponse.data,
        zodError: error.cause instanceof ZodError ? z.treeifyError(error.cause) : null,
      },
    };
  },
});

/**
 * Create a server-side caller
 * @see https://trpc.io/docs/server/server-side-calls
 */
export const createCallerFactory = t.createCallerFactory;

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router;

const loggerMiddleware = t.middleware(async ({ path, next, ctx, type }) => {
  const start = Date.now();
  try {
    const result = await next({
      ctx: { ...ctx },
    });
    const durationInMs = Date.now() - start;

    if (result.ok) {
      logger.info(`[${type}]: ${path} - ${durationInMs}ms - OK`);
    } else {
      logger.error(`[${type}] ${path} - ${durationInMs}ms - ${result.error.code} ${result.error.message}`);
    }
    return result;
  } catch (error) {
    const durationInMs = Date.now() - start;
    const errorCode = error instanceof TRPCError ? error.code : "UNCAUGHT";
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[${type}] ${path} - ${durationInMs}ms - ${errorCode} ${message}`);
    throw error;
  }
});

const baseProcedure = t.procedure.use(loggerMiddleware);
const verificationKeyInputSchema = z.object({ key: z.string().min(1) });

const enforceUser = t.middleware(async ({ ctx, next, getRawInput }) => {
  if (ctx.user) {
    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }
  let verificationKey = getVerificationKey(ctx.req);
  if (!verificationKey) {
    const rawInput = await getRawInput();
    const parsedInput = verificationKeyInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    verificationKey = parsedInput.data.key;
  }

  if (!verificationKey) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const user = await ctx.prisma.student.findUnique({ where: { verificationKey } });
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      user,
    },
  });
});

const enforceUserIsAdminOrMod = t.middleware(({ ctx, next }) => {
  const isAuthed = ctx.req && isAuthenticated(ctx.req);
  if (!isAuthed) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  return next({
    ctx,
  });
}); /**
 * Public (unauthenticated) procedure
 *
 * This is the base piece you use to build new queries and mutations on your tRPC API. It does not
 * guarantee that a user querying is authorized, but you can still access user session data if they
 * are logged in.
 */
export const publicProcedure = baseProcedure;
export const adminProcedure = baseProcedure.use(enforceUserIsAdminOrMod);
export const publicProcedureWithUser = baseProcedure.use(enforceUser);
