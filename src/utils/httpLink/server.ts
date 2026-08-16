import { httpLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextPageContext } from "next";
import type { GetServerSidePropsContext } from "next/types";
import { createInnerTRPCContext } from "@/server/api/trpc";
import { transformer } from "@/server/api/transformer";
import { appRouter } from "@/server/api";

const serverLink = (ctx: NextPageContext | GetServerSidePropsContext | undefined | null) => {
  const createContext = async () => {
    const req = ctx?.req;
    const res = ctx?.res;
    return createInnerTRPCContext({ req, res });
  };
  const context = createContext();
  return httpLink({
    transformer,
    url: `http://fake/api/data`,
    headers() {
      if (!ctx?.req?.headers) {
        return {};
      }
      // To use SSR properly, you need to forward client headers to the server
      // This is so you can pass through things like cookies when we're server-side rendering
      return {
        cookie: ctx.req.headers.cookie,
      };
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);

      return fetchRequestHandler({
        endpoint: "/api/data",
        req: request,
        router: appRouter,
        createContext: () => context,
      });
    },
  });
};
export default serverLink;
