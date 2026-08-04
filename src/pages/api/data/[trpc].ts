import { createNextApiHandler } from "@trpc/server/adapters/next";
import type { NodeHTTPHandlerOptions } from "@trpc/server/adapters/node-http";
import { appRouter, createTRPCContext } from "@/server/api";
import type { NextApiRequest, NextApiResponse } from "next";

// export API handler
const onError: NodeHTTPHandlerOptions<any, any, any>["onError"] =
  process.env.NODE_ENV === "development"
    ? ({ path, error }) => {
        console.error(`❌ tRPC failed on ${path ?? "<no-path>"}: ${error.message}`);
      }
    : undefined;

const nextApiHandler = createNextApiHandler({
  router: appRouter,
  createContext: createTRPCContext,
  onError,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<any | void> {
  // We can use the response object to enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Request-Method", "*");
  res.setHeader("Access-Control-Allow-Methods", "OPTIONS, GET, POST");
  res.setHeader("Access-Control-Allow-Headers", "*");
  // If you need to make authenticated CORS calls then
  // remove what is above and uncomment the below code
  // Allow-Origin has to be set to the requesting domain that you want to send the credentials back to
  // res.setHeader('Access-Control-Allow-Origin', 'http://example:6006');
  // res.setHeader('Access-Control-Request-Method', '*');
  // res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET');
  // res.setHeader('Access-Control-Allow-Headers', 'content-type');
  // res.setHeader('Referrer-Policy', 'no-referrer');
  // res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }
  // finally pass the request on to the tRPC handler
  return nextApiHandler(req, res);
}
