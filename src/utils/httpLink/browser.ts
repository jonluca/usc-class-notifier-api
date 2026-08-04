import { httpLink } from "@trpc/client";
// import { unstable_httpBatchStreamLink } from "@trpc/client";
import type { NextPageContext } from "next";
import { transformer } from "@/server/api/transformer";
import { createWindowFetch } from "@/utils/windowFetch";

const getBaseUrl = () => {
  if (typeof window !== "undefined") {
    return "";
  } // browser should use relative url
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  } // SSR should use vercel url
  return `http://localhost:${process.env.PORT ?? 3000}`; // dev SSR should use localhost
};

const browserLink = (_: NextPageContext | null) => {
  return httpLink({ transformer, url: `${getBaseUrl()}/api/data`, fetch: createWindowFetch(window) });
  // return unstable_httpBatchStreamLink({ transformer, url: `${getBaseUrl()}/api/data`, maxURLLength: 2000 });
};
export default browserLink;
