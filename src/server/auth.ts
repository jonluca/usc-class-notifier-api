import type { NextRequest } from "next/server";
import type { IncomingMessage } from "http";
import { getCookies } from "@/server/utils/cookie";

export const cookieKey = "verificationKey";

export function getVerificationKey(req: NextRequest | IncomingMessage | null | undefined) {
  const cookies = getCookies(req);

  // `key` was used by an older version of the app. Prefer the current cookie
  // so an old login cannot override a newer email link.
  return cookies[cookieKey] || cookies.key;
}

const adminPassword = process.env.ADMIN_PASSWORD;

export function isAuthenticated(req: NextRequest | IncomingMessage) {
  // req might be a NextRequest or an IncomingMessage
  // convert Headers | IncomingHttpHeaders to Headers
  const headers = req.headers instanceof Headers ? req.headers : new Headers(req.headers as any);
  const authheader = headers.get("authorization") || headers.get("Authorization");

  if (!authheader) {
    return false;
  }

  const encodedCredentials = authheader.split(" ")[1];
  if (!encodedCredentials) {
    return false;
  }
  const auth = Buffer.from(encodedCredentials, "base64").toString().split(":");
  const pass = auth[1];

  if (adminPassword && pass == adminPassword) {
    return true;
  } else {
    return false;
  }
}
