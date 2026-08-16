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

const normalizeHeaders = (req: NextRequest | IncomingMessage): Headers => {
  if (req.headers instanceof Headers) {
    return req.headers;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
};

export function isAuthenticated(req: NextRequest | IncomingMessage) {
  const headers = normalizeHeaders(req);
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

  return Boolean(adminPassword && pass === adminPassword);
}
