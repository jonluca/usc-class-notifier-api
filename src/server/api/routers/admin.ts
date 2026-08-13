import type { TRPCRouterRecord } from "@trpc/server";
import { adminProcedure } from "../trpc";
import { z } from "zod/v4";
import { runRefresh } from "@/server/api/controller";
import {
  acquirePaidReferenceAllocationLock,
  generatePaidReferenceCandidates,
  selectAvailablePaidReference,
  selectPaidReferenceRepairRows,
} from "@/server/paidReference";
import { getValidSemesters } from "@/utils/semester";

const paidReferenceSchema = z.string().regex(/^\d{8}$/, "Payment references must be exactly eight digits");

export const adminRouter = {
  refresh: adminProcedure.query(async () => {
    return runRefresh();
  }),
  getUserKey: adminProcedure
    .input(
      z.object({
        email: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { email } = input;
      return ctx.prisma.student.findUnique({
        where: {
          email,
        },
      });
    }),
  addPaidId: adminProcedure
    .input(
      z.object({
        paidIds: z.array(paidReferenceSchema).min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { paidIds } = input;
      const uniquePaidIds = [...new Set(paidIds)];
      const matchingRows = await ctx.prisma.watchedSection.findMany({
        where: {
          paidId: { in: uniquePaidIds },
        },
        select: { id: true, paidId: true, semester: true },
      });
      const rowsByReference = new Map<string, Array<{ id: string; semester: string }>>();
      for (const row of matchingRows) {
        rowsByReference.set(row.paidId, [
          ...(rowsByReference.get(row.paidId) || []),
          { id: row.id, semester: row.semester },
        ]);
      }

      const eligibleRowIds: string[] = [];
      const monitoredSemesters = new Set(getValidSemesters());
      let unmatched = 0;
      let ambiguous = 0;
      for (const paidId of uniquePaidIds) {
        const rows = rowsByReference.get(paidId) || [];
        if (rows.length === 1 && monitoredSemesters.has(rows[0]!.semester)) {
          eligibleRowIds.push(rows[0]!.id);
        } else if (rows.length === 0) {
          unmatched += 1;
        } else {
          ambiguous += 1;
        }
      }

      const result = await ctx.prisma.watchedSection.updateMany({
        where: { id: { in: eligibleRowIds }, paidId: { in: uniquePaidIds } },
        data: { isPaid: true },
      });
      return { updated: result.count, unmatched, ambiguous };
    }),
  getStudentByPaidId: adminProcedure
    .input(
      z.object({
        paidId: paidReferenceSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { paidId } = input;
      const matches = await ctx.prisma.watchedSection.findMany({
        where: {
          paidId,
        },
        include: {
          student: true,
        },
      });
      if (matches.length > 1) {
        throw new Error("Payment reference matches multiple sections and must be reconciled first");
      }
      return matches[0] || null;
    }),
  repairLegacyUnpaidPaidIds: adminProcedure.mutation(async ({ ctx }) => {
    return ctx.prisma.$transaction(async (transaction) => {
      await acquirePaidReferenceAllocationLock(transaction);

      const rows = await transaction.watchedSection.findMany({
        select: { id: true, paidId: true, isPaid: true },
      });
      const repairRows = selectPaidReferenceRepairRows(rows);
      let repaired = 0;

      for (const row of repairRows) {
        const candidates = generatePaidReferenceCandidates();
        const matchingSections = await transaction.watchedSection.findMany({
          where: { paidId: { in: candidates } },
          select: { paidId: true },
        });
        const paidId = selectAvailablePaidReference(
          candidates,
          matchingSections.map((matchingSection) => matchingSection.paidId),
        );
        if (!paidId) {
          throw new Error("Could not allocate a globally unique payment reference");
        }

        const update = await transaction.watchedSection.updateMany({
          where: { id: row.id, paidId: row.paidId, isPaid: false },
          data: { paidId },
        });
        repaired += update.count;
      }

      return { eligible: repairRows.length, repaired };
    });
  }),
} satisfies TRPCRouterRecord;
