import Dashboard from "@/components/Dashboard";
import { cookieKey } from "@/server/auth";
import { prisma } from "@/server/db";
import { setCookie } from "@/server/utils/cookie";
import dayjs from "dayjs";
import type { GetServerSideProps } from "next";

export default Dashboard;

export const getServerSideProps: GetServerSideProps = async ({ query, res }) => {
  const key = Array.isArray(query.key) ? query.key[0] : query.key;
  if (!key) {
    return { props: {} };
  }

  const student = await prisma.student.findUnique({
    where: { verificationKey: key },
    select: { validAccount: true },
  });

  if (!student) {
    return { props: {} };
  }

  setCookie(res, cookieKey, key, {
    expires: dayjs().add(1, "year").toDate(),
    httpOnly: false,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  // Older "Now Watching" emails linked straight to the dashboard. Route
  // unverified recipients through verification so those existing links can
  // activate notifications too.
  if (student && !student.validAccount) {
    return {
      redirect: {
        destination: `/verify?key=${encodeURIComponent(key)}`,
        permanent: false,
      },
    };
  }

  // Reload without the credential in the address bar. The cookie is already
  // present before any user-specific query can run.
  return {
    redirect: {
      destination: "/dashboard",
      permanent: false,
    },
  };
};
