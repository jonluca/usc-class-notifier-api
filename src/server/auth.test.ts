import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { NextRequest } from "next/server";
import { getVerificationKey } from "@/server/auth";

const requestWithCookies = (cookies: string) => {
  const request = new IncomingMessage(new Socket());
  request.headers.cookie = cookies;
  return request;
};

test("reads the current verification cookie", () => {
  assert.equal(getVerificationKey(requestWithCookies("verificationKey=current-user")), "current-user");
});

test("prefers the current cookie over a stale legacy cookie", () => {
  assert.equal(getVerificationKey(requestWithCookies("key=old-user; verificationKey=current-user")), "current-user");
});

test("supports the legacy cookie when no current cookie exists", () => {
  assert.equal(getVerificationKey(requestWithCookies("key=legacy-user")), "legacy-user");
});

test("reads cookies from NextRequest headers", () => {
  const request = new NextRequest("https://example.com", {
    headers: { cookie: "verificationKey=edge-user" },
  });

  assert.equal(getVerificationKey(request), "edge-user");
});
