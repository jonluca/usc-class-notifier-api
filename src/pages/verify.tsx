import { useRouter } from "next/router";
import { api } from "@/utils/api";
import { SendLoginEmail } from "@/components/SendLoginEmail";
import { LinearProgress } from "@mui/material";
import Link from "next/link";
import type { GetServerSideProps } from "next";
import { setCookie } from "@/server/utils/cookie";
import dayjs from "dayjs";
import { cookieKey } from "@/server/auth";
import type { ParsedUrlQuery } from "node:querystring";

const readQueryValue = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const createSearchParams = (query: ParsedUrlQuery) => {
  const searchParams = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(name, item);
      }
    } else if (value !== undefined) {
      searchParams.set(name, value);
    }
  }
  return searchParams;
};

export default function Verify() {
  const router = useRouter();

  const key = readQueryValue(router.query.key);

  const enabled = Boolean(key);
  const { data, isLoading, error } = api.user.verifyByKey.useQuery(
    {
      key: key || "",
    },
    {
      enabled,
    },
  );
  if (!enabled || error) {
    return (
      <div className={"flex flex-col justify-center items-center h-full w-full"}>
        <SendLoginEmail />
        {error && <p className={"text-red-500"}>{error.message}</p>}
      </div>
    );
  }

  return (
    <div className={"h-full p-4"}>
      {isLoading && <LinearProgress />}
      {data && data.success ? (
        <div className="flex flex-col items-center justify-center h-full gap-6">
          <div className="space-y-2 text-center">
            <h1 className="text-3xl font-bold">Email Verified</h1>
            <p className="text-gray-500 dark:text-gray-400 max-w-md">
              Congratulations! Your email address has been successfully verified. You can now continue to your
              dashboard.
            </p>
          </div>
          <Link
            className="inline-flex h-10 items-center justify-center rounded-md bg-gray-900 px-8 text-sm font-medium text-gray-50 shadow-sm transition-colors hover:bg-gray-900/90 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50"
            href={`/dashboard?${createSearchParams(router.query).toString()}`}
          >
            Continue to App
          </Link>
        </div>
      ) : (
        <div className={"flex flex-col justify-center items-center h-full w-full"}>
          <div className={"text-xl"}>Error</div>
          {data?.message}
        </div>
      )}
    </div>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const key = readQueryValue(context.query.key);
  if (key) {
    setCookie(context.res, cookieKey, key, {
      expires: dayjs().add(1, "year").toDate(),
      httpOnly: false,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }
  return {
    props: {},
  };
};
