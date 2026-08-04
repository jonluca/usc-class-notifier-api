import { httpLink } from "@trpc/client";
import type { AppRouter } from "@/server/api";
import { transformer } from "@/server/api/transformer";
import { createTRPCReact } from "@trpc/react-query";
import { baseDomain } from "@/constants";
import { createWindowFetch } from "@/utils/windowFetch";

export const trpc = createTRPCReact<AppRouter>();

export const trpcClient = trpc.createClient({
  links: [
    httpLink({
      url: `${baseDomain}/api/data`,
      transformer,
      fetch: createWindowFetch(window),
    }),
  ],
});
