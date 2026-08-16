/**
 * This is the client-side entrypoint for your tRPC API. It is used to create the `api` object which
 * contains the Next.js App-wrapper, as well as your type-safe React Query hooks.
 *
 * We also create a few inference helpers for input and output types.
 */
import { loggerLink } from "@trpc/client";
import { createTRPCNext } from "@trpc/next";
import { type inferRouterInputs, type inferRouterOutputs } from "@trpc/server";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import getLink from "./httpLink";
import type { AppRouter } from "@/server/api/root";
import { transformer } from "@/server/api/transformer";
import { toast } from "react-toastify";

/** A set of type-safe react-query hooks for your tRPC API. */
export const api = createTRPCNext<AppRouter>({
  /**
   * Transformer used for data de-serialization from the server.
   *
   * @see https://trpc.io/docs/data-transformers
   */
  transformer,
  config(opts) {
    const ctx = opts?.ctx;
    const queryCache = new QueryCache({
      onError: (error, query) => {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(`[${String(query.queryKey[0])}]: ${message}`);
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 1000 * 60 * 15, // 15 minutes
          refetchIntervalInBackground: false,
          networkMode: "always",
          refetchOnMount: false,
          refetchOnWindowFocus: false,
        },
        mutations: {
          networkMode: "always",
        },
      },
      queryCache,
    });

    const link = getLink(ctx);

    return {
      /**
       * Links used to determine request flow from client to server.
       *
       * @see https://trpc.io/docs/links
       */
      links: [
        loggerLink({
          enabled: (opts) =>
            process.env.NODE_ENV === "development" || (opts.direction === "down" && opts.result instanceof Error),
        }),
        link,
      ],
      queryClient,
      headers: () => {
        if (ctx?.req) {
          // on ssr, forward client's headers to the server
          return {
            ...ctx.req.headers,
            "x-ssr": "1",
          };
        }
        return {};
      },
    };
  },
  /**
   * Whether tRPC should await queries when server rendering pages.
   *
   * @see https://trpc.io/docs/nextjs#ssr-boolean-default-false
   */
  ssr: false,
});

/**
 * Inference helper for inputs.
 *
 * @example type HelloInput = RouterInputs['example']['hello']
 */
export type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * Inference helper for outputs.
 *
 * @example type HelloOutput = RouterOutputs['example']['hello']
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
