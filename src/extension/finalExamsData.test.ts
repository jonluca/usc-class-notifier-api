import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CACHE_TTL_MS,
  finalExamsCacheKey,
  loadFinalExamData,
  type FinalExamsCacheEntry,
  type FinalExamsDataDependencies,
} from "@/extension/finalExamsData";
import { FINAL_EXAMS_FALLBACK } from "@/extension/finalExamsFallback";
import { fetchFinalExamsPage, type FinalExamsPageResponse } from "@/extension/finalExamsMessages";
import { parseDetachedDocument } from "@/extension/testing/detachedDocument";

const FIXTURE = readFileSync(new URL("./fixtures/finalExamSchedule-2026-10-27.html", import.meta.url), "utf8");
const NOW = Date.UTC(2026, 10, 1, 22, 0, 0);
const SPRING = FINAL_EXAMS_FALLBACK.find((term) => term.termId === "20271")!;
// Parsing needs a real Document; build one up front so the injected parseHtml stays synchronous.
const FIXTURE_DOC = await parseDetachedDocument(FIXTURE);
const BROKEN_DOC = await parseDetachedDocument(FIXTURE.replace(">COURSE<", ">COURSE CODE<"));

interface Harness {
  deps: FinalExamsDataDependencies;
  cache: Map<string, FinalExamsCacheEntry>;
  warnings: string[];
  pageRequests: number;
}

function harness(page: FinalExamsPageResponse, docFor: Document = FIXTURE_DOC): Harness {
  const state: Harness = {
    cache: new Map(),
    warnings: [],
    pageRequests: 0,
    deps: {
      now: () => NOW,
      readCache: async (key) => state.cache.get(key) ?? null,
      writeCache: async (key, entry) => {
        state.cache.set(key, entry);
      },
      requestPage: async () => {
        state.pageRequests += 1;
        return page;
      },
      parseHtml: () => docFor,
      warn: (message) => {
        state.warnings.push(message);
      },
    },
  };
  return state;
}

const LIVE: FinalExamsPageResponse = { ok: true, html: "<html></html>" };
const NO_PERMISSION: FinalExamsPageResponse = { ok: false, reason: "permission", error: "not granted" };

test("live page parses, is cached, and a fresh cache short-circuits the next load", async () => {
  const h = harness(LIVE);
  const first = await loadFinalExamData("20271", h.deps);
  assert.equal(first.status === "published" && first.source, "live");
  assert.deepEqual(first.status === "published" && first.data, SPRING);
  assert.equal(h.cache.get(finalExamsCacheKey("20271"))?.fetchedAt, NOW);

  const second = await loadFinalExamData("20271", h.deps);
  assert.equal(second.status === "published" && second.source, "cache");
  assert.equal(h.pageRequests, 1);

  const forced = await loadFinalExamData("20271", h.deps, true);
  assert.equal(forced.status === "published" && forced.source, "live");
  assert.equal(h.pageRequests, 2);
});

test("without the arr.usc.edu permission it uses bundled data and says so", async () => {
  const h = harness(NO_PERMISSION);
  const result = await loadFinalExamData("20263", h.deps);
  assert.equal(result.status, "published");
  assert.equal(result.status === "published" && result.source, "fallback");
  assert.equal(result.needsPermission, true);
  assert.equal(result.status === "published" && result.fetchedAt, null);
  // Not having the optional permission is normal, so nothing is logged.
  assert.deepEqual(h.warnings, []);
});

test("a stale cache beats bundled data when the live page can't be read", async () => {
  const h = harness(NO_PERMISSION);
  const staleAt = NOW - CACHE_TTL_MS - 1;
  h.cache.set(finalExamsCacheKey("20271"), { fetchedAt: staleAt, data: { ...SPRING, unparsedRows: ["marker"] } });
  const result = await loadFinalExamData("20271", h.deps);
  assert.equal(result.status === "published" && result.source, "cache");
  assert.equal(result.status === "published" && result.fetchedAt, staleAt);
  assert.deepEqual(result.status === "published" && result.data.unparsedRows, ["marker"]);
  assert.equal(h.pageRequests, 1);
});

test("unexpected live markup falls back and logs the parser's reason (never caches a failure)", async () => {
  const h = harness(LIVE, BROKEN_DOC);
  const result = await loadFinalExamData("20271", h.deps);
  assert.equal(result.status === "published" && result.source, "fallback");
  assert.equal(result.needsPermission, false);
  assert.match(h.warnings.join("\n"), /couldn't parse the live page: Unrecognised final exam table headers/);
  assert.equal(h.cache.size, 0);
});

test("a corrupted cache entry is ignored", async () => {
  const h = harness(LIVE);
  // Storage is untyped at runtime; this is what an older or broken entry could look like.
  h.deps.readCache = async () => JSON.parse('{"fetchedAt": 1793570000000, "data": {"termId": "20271"}}');
  const result = await loadFinalExamData("20271", h.deps);
  assert.equal(result.status === "published" && result.source, "live");
});

test("terms beyond the published ones are 'not published yet'", async () => {
  const live = harness(LIVE);
  assert.deepEqual(await loadFinalExamData("20273", live.deps), {
    status: "unpublished",
    termId: "20273",
    needsPermission: false,
    checkedLive: true,
  });
  const offline = harness(NO_PERMISSION);
  assert.deepEqual(await loadFinalExamData("20273", offline.deps), {
    status: "unpublished",
    termId: "20273",
    needsPermission: true,
    checkedLive: false,
  });
  // Summer has no university final exam schedule; no fetch is attempted.
  const summer = harness(LIVE);
  assert.equal((await loadFinalExamData("20272", summer.deps)).status, "unpublished");
  assert.equal(summer.pageRequests, 0);
});

function fakeResponse(body: string, status = 200, url = "https://arr.usc.edu/final-exam-schedule/"): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("background fetch: requires the optional permission before touching the network", async () => {
  let fetched = 0;
  const fetchImpl: typeof fetch = async () => {
    fetched += 1;
    return fakeResponse("<html></html>");
  };
  const denied = await fetchFinalExamsPage({ contains: async () => false }, fetchImpl);
  assert.deepEqual(denied, { ok: false, reason: "permission", error: "arr.usc.edu access hasn't been granted." });
  assert.equal(fetched, 0);

  const allowed = await fetchFinalExamsPage({ contains: async () => true }, fetchImpl);
  assert.deepEqual(allowed, { ok: true, html: "<html></html>" });
});

test("background fetch: HTTP errors, foreign redirects and thrown errors are network failures", async () => {
  const granted = { contains: async () => true };
  assert.deepEqual(await fetchFinalExamsPage(granted, async () => fakeResponse("", 503)), {
    ok: false,
    reason: "network",
    error: "HTTP 503",
  });
  assert.deepEqual(
    await fetchFinalExamsPage(granted, async () => fakeResponse("<html></html>", 200, "https://login.usc.edu/sso")),
    { ok: false, reason: "network", error: "redirected to https://login.usc.edu" },
  );
  assert.deepEqual(
    await fetchFinalExamsPage(granted, async () => {
      throw new Error("offline");
    }),
    { ok: false, reason: "network", error: "offline" },
  );
});
