import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";
import { getD1Executor } from "@/server/d1/executor";
import { isMaintenanceMode } from "@/server/maintenance";

export function createHealthHandler(database = prisma) {
  return async function health(req: NextApiRequest, res: NextApiResponse) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).end();
    }
    const state = {
      databaseProvider: getD1Executor(database) ? "d1" : "postgres",
      maintenance: isMaintenanceMode(),
      revision: process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_REVISION || null,
    };
    try {
      await database.$queryRaw`SELECT 1`;
      // Exercise signup's Prisma query shape: a trivial SELECT can pass an edge
      // filter that blocks the composite-key lookup. These keys cannot be USC data.
      await database.classInfo.findUnique({
        where: { section_semester: { section: "__health_probe__", semester: "00000" } },
        select: { id: true, isCancelled: true },
      });
      return res.status(200).json({ ready: true, ...state });
    } catch {
      return res.status(503).json({ ready: false, ...state });
    }
  };
}

export default createHealthHandler();
