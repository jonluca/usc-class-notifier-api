import { cookieKey } from "@/server/auth";
import { prisma } from "@/server/db";
import { setCookie } from "@/server/utils/cookie";
import dayjs from "dayjs";
import type { GetServerSidePropsContext } from "next";

const readQueryValue = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function loadWatchPageProps({
  query,
  res,
}: Pick<GetServerSidePropsContext, "query" | "res">): Promise<{ didSucceed: boolean; section: string }> {
  const key = readQueryValue(query.key);
  const section = readQueryValue(query.section);
  let didSucceed = false;

  if (key) {
    const student = await prisma.student.findUnique({
      where: { verificationKey: key },
      select: { id: true },
    });

    if (!student) {
      return { didSucceed, section: section || "" };
    }

    setCookie(res, cookieKey, key, {
      expires: dayjs().add(1, "year").toDate(),
      httpOnly: false,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });

    if (section) {
      const update = await prisma.watchedSection.updateMany({
        where: { id: section, studentId: student.id },
        data: { notified: false },
      });
      didSucceed = update.count === 1;
    }
  }

  return { didSucceed, section: section || "" };
}
