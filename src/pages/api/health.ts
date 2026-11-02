import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/server/db";
import { getD1Executor } from "@/server/d1/executor";
import { isMaintenanceMode } from "@/server/maintenance";

export default async function health(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  const state = {
    databaseProvider: getD1Executor(prisma) ? "d1" : "postgres",
    maintenance: isMaintenanceMode(),
    revision: process.env.APP_REVISION || process.env.VERCEL_GIT_COMMIT_SHA || null,
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({ ready: true, ...state });
  } catch {
    return res.status(503).json({ ready: false, ...state });
  }
}
