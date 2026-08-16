import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { publicProcedure, publicProcedureWithUser } from "../trpc";
import { z } from "zod/v4";
import { v4 as uuid } from "uuid";
import { verificationEmail } from "@/emails/processors/verificationEmail";

import { validDepartments } from "@/utils/validDepartments";
import { nowWatchingEmail } from "@/emails/processors/nowWatchingEmail";
import {
  assertMatchingClassInfo,
  assertMonitoredSemester,
  notificationSemesterSchema,
} from "@/server/api/notificationSignup";
import {
  acquirePaidReferenceAllocationLock,
  generatePaidReferenceCandidates,
  needsPaidReferenceRotation,
  selectAvailablePaidReference,
} from "@/server/paidReference";
import { parsePhoneNumber, PHONE_NUMBER_ERROR } from "@/utils/phoneNumber";
import type { Prisma } from "@app/prisma";

const optionalPhoneNumberSchema = z
  .string()
  .trim()
  .max(64)
  .transform((value, context) => {
    if (!value) {
      return undefined;
    }
    const parsed = parsePhoneNumber(value);
    if (!parsed) {
      context.addIssue({ code: "custom", message: PHONE_NUMBER_ERROR });
      return z.NEVER;
    }
    return parsed;
  })
  .optional();

const phoneNumberSchema = z
  .string()
  .trim()
  .max(64)
  .transform((value, context) => {
    const parsed = parsePhoneNumber(value);
    if (!parsed) {
      context.addIssue({ code: "custom", message: PHONE_NUMBER_ERROR });
      return z.NEVER;
    }
    return parsed;
  });

export const userRouter = {
  verifyByKey: publicProcedure
    .input(
      z.object({
        key: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const user = await ctx.prisma.student.findFirst({
        where: {
          verificationKey: input.key,
        },
      });
      if (!user) {
        return {
          success: false,
          message: "User not found",
        };
      }

      await ctx.prisma.student.update({
        where: {
          id: user.id,
        },
        data: {
          validAccount: true,
        },
      });

      return {
        success: true,
        message: "Verification successful",
      };
    }),
  hasUser: publicProcedure.query(async ({ ctx }) => {
    return Boolean(ctx.user);
  }),
  getDepartments: publicProcedure.query(async () => {
    return validDepartments;
  }),
  getWatchedClasses: publicProcedureWithUser.query(async ({ ctx }) => {
    const user = ctx.user;
    if (!user) {
      throw new Error("User not found");
    }
    return ctx.prisma.watchedSection.findMany({
      where: {
        studentId: user.id,
      },
      include: {
        ClassInfo: true,
      },
    });
  }),
  getUserInfo: publicProcedureWithUser.query(async ({ ctx }) => {
    const user = ctx.user;
    return user;
  }),
  addWatchedClass: publicProcedure
    .input(
      z.object({
        sectionNumber: z.string(),
        email: z.email(),
        department: z.string(),
        phone: optionalPhoneNumberSchema,
        uscId: z.string().optional(),
        semester: notificationSemesterSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertMonitoredSemester(input.semester);

      const classInfo = await ctx.prisma.classInfo.findUnique({
        where: {
          section_semester: {
            section: input.sectionNumber,
            semester: input.semester,
          },
        },
      });
      assertMatchingClassInfo(classInfo, input.sectionNumber, input.semester);

      let student = await ctx.prisma.student.findUnique({
        where: {
          email: input.email,
        },
      });
      if (!student) {
        // create user
        student = await ctx.prisma.student.create({
          data: {
            email: input.email,
            verificationKey: uuid(),
            uscID: input.uscId,
          },
        });
      }
      // now check if this student is already watching this section
      const section = await ctx.prisma.watchedSection.findFirst({
        where: {
          section: input.sectionNumber,
          studentId: student.id,
          semester: input.semester,
        },
      });
      const showVenmoInfo = Boolean(parsePhoneNumber(student.phone || "") || input.phone);
      const ownsStudent = ctx.user?.id === student.id;

      if (section) {
        if (!ownsStudent) {
          return {
            alreadyWatching: true as const,
            loginRequired: true as const,
            // Keep the 15.5.0 extension usable while 15.5.1 clears store
            // review. These values disclose nothing beyond this request and
            // ensure the old client shows a safe, payment-free recovery state.
            email: input.email,
            isVerifiedAccount: true,
            isPaid: false,
            showVenmoInfo: false,
            paidId: "",
          };
        }
        const updatedSection = await ctx.prisma.$transaction(async (transaction) => {
          // Serialize and reload before deciding whether a legacy reference
          // needs rotation. Concurrent re-adds must return the same final code.
          await acquirePaidReferenceAllocationLock(transaction);
          const currentSection = await transaction.watchedSection.findUnique({
            where: { id: section.id },
          });
          if (!currentSection) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Section not found" });
          }

          let paidId = currentSection.paidId;
          if (needsPaidReferenceRotation(currentSection.paidId, currentSection.isPaid)) {
            // A small number of legacy rows have 1-7 digit references. Rotate
            // only unpaid rows when their user returns.
            const candidates = generatePaidReferenceCandidates();
            const matchingSections = await transaction.watchedSection.findMany({
              where: { paidId: { in: candidates } },
              select: { paidId: true },
            });
            const availablePaidId = selectAvailablePaidReference(
              candidates,
              matchingSections.map((matchingSection) => matchingSection.paidId),
            );
            if (!availablePaidId) {
              throw new Error("Please try again later. We are currently at capacity.");
            }
            paidId = availablePaidId;
          }

          const sectionUpdate: Prisma.WatchedSectionUpdateInput = { paidId };
          if (ownsStudent) {
            sectionUpdate.notified = false;
            if (input.phone) {
              sectionUpdate.phoneOverride = input.phone;
            }
          }

          return transaction.watchedSection.update({
            where: {
              id: section.id,
            },
            data: sectionUpdate,
            include: { ClassInfo: true },
          });
        });

        // Re-adding from an authenticated dashboard is a safe resend/recovery path.
        const shouldShowVenmoInfo =
          Boolean(parsePhoneNumber(updatedSection.phoneOverride || "") || parsePhoneNumber(student.phone || "")) &&
          !updatedSection.isPaid;
        await nowWatchingEmail({
          verificationKey: student.verificationKey,
          email: student.email,
          sectionEntry: updatedSection,
          classInfo: updatedSection.ClassInfo || null,
          isVerifiedAccount: student.validAccount,
          showVenmoInfo: shouldShowVenmoInfo,
        });
        return {
          ...updatedSection,
          alreadyWatching: true as const,
          isVerifiedAccount: student.validAccount,
          showVenmoInfo: shouldShowVenmoInfo,
          email: input.email,
        };
      }

      const created = await ctx.prisma.$transaction(async (transaction) => {
        // The schema's uniqueness constraint includes semester, but Venmo receipts
        // contain only paidId. Serialize allocation across every API instance so a
        // reference can never be reused by a different semester.
        await acquirePaidReferenceAllocationLock(transaction);

        const candidates = generatePaidReferenceCandidates();
        const matchingSections = await transaction.watchedSection.findMany({
          where: {
            paidId: {
              in: candidates,
            },
          },
          select: { paidId: true },
        });
        const paidId = selectAvailablePaidReference(
          candidates,
          matchingSections.map((matchingSection) => matchingSection.paidId),
        );

        if (!paidId) {
          throw new Error("Please try again later. We are currently at capacity.");
        }

        return transaction.watchedSection.create({
          data: {
            section: input.sectionNumber,
            studentId: student.id,
            phoneOverride: input.phone,
            semester: input.semester,
            paidId,
            classInfoId: classInfo.id,
          },
          include: {
            ClassInfo: true,
          },
        });
      });
      await ctx.prisma.$executeRaw`UPDATE "WatchedSection" ws
SET "classInfoId" = ci.id
FROM "ClassInfo" ci
WHERE ws."classInfoId" is null and ws.section = ci.section AND ws.semester = ci.semester`;
      await nowWatchingEmail({
        verificationKey: student.verificationKey,
        email: student.email,
        sectionEntry: created,
        classInfo: created.ClassInfo || null,
        isVerifiedAccount: student.validAccount,
        showVenmoInfo,
      });
      return {
        ...created,
        alreadyWatching: false,
        isVerifiedAccount: student.validAccount,
        showVenmoInfo,
        email: input.email,
      };
    }),

  continueReceivingNotificationsForSection: publicProcedureWithUser
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const update = await ctx.prisma.watchedSection.updateMany({
        where: {
          id: input.id,
          studentId: ctx.user.id,
        },
        data: {
          notified: false,
        },
      });
      if (update.count !== 1) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Section not found" });
      }
    }),
  setAccountLevelPhoneToAllSections: publicProcedureWithUser.mutation(async ({ ctx }) => {
    const phoneNumber = ctx.user.phone ? parsePhoneNumber(ctx.user.phone) : null;
    if (ctx.user.phone && !phoneNumber) {
      throw new TRPCError({ code: "BAD_REQUEST", message: PHONE_NUMBER_ERROR });
    }
    await ctx.prisma.watchedSection.updateMany({
      where: {
        studentId: ctx.user.id,
      },
      data: {
        phoneOverride: phoneNumber,
      },
    });
  }),
  changePhoneNumberForSection: publicProcedureWithUser
    .input(
      z.object({
        id: z.string(),
        phoneNumber: phoneNumberSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const update = await ctx.prisma.watchedSection.updateMany({
        where: {
          id: input.id,
          studentId: ctx.user.id,
        },
        data: {
          phoneOverride: input.phoneNumber,
        },
      });
      if (update.count !== 1) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Section not found" });
      }
    }),
  changePhoneNumberForAccount: publicProcedureWithUser
    .input(
      z.object({
        phoneNumber: phoneNumberSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new Error("User not found");
      }
      await ctx.prisma.student.update({
        where: {
          id: ctx.user.id,
        },
        data: {
          phone: input.phoneNumber,
        },
      });
    }),
  sendLoginEmail: publicProcedure
    .input(
      z.object({
        email: z.email(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let student = await ctx.prisma.student.findUnique({
        where: {
          email: input.email,
        },
      });
      if (!student) {
        // create user
        student = await ctx.prisma.student.create({
          data: {
            email: input.email,
            verificationKey: uuid(),
          },
        });
      }
      const isVerifiedAlready = student.validAccount;
      await verificationEmail({ email: student.email, isVerifiedAlready, key: student.verificationKey });
      // send email
    }),
  updatePhoneNumberForUser: publicProcedureWithUser
    .input(
      z.object({
        key: z.string(),
        phoneNumber: phoneNumberSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.student.update({
        where: {
          id: ctx.user.id,
        },
        data: {
          phone: input.phoneNumber,
        },
      });
    }),
} satisfies TRPCRouterRecord;
