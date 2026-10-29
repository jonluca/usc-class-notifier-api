import type { TRPCRouterRecord } from "@trpc/server";
import { z } from "zod/v4";
import { searchSections } from "@/server/api/classSearch";
import { notificationSemesterSchema } from "@/server/api/notificationSignup";
import { publicProcedure } from "@/server/api/trpc";

export const catalogRouter = {
  searchSections: publicProcedure
    .input(
      z.object({
        semester: notificationSemesterSchema,
        query: z.string().trim().min(2, "Enter at least two characters to search.").max(100),
      }),
    )
    .query(({ ctx, input }) => searchSections(ctx.prisma, input.semester, input.query)),
} satisfies TRPCRouterRecord;
