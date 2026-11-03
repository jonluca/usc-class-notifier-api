// Live → cache → bundled-fallback loader for the final-exam schedule, plus the background-side fetch.
//
// Flow (content script): fresh cache hit → done. Otherwise ask the background worker for the raw page
// (MV3 service workers have no DOMParser, so the content script parses it), parse the active term, and
// cache the parsed data for CACHE_TTL_MS. Anything that goes wrong (no arr.usc.edu permission,
// network, unexpected markup) falls back to a stale cache entry if there is one, otherwise to the
// bundled copy (finalExamsFallback.ts), and logs why. A term with no data anywhere is "unpublished".
//
// arr.usc.edu is an *optional* host permission: requesting it at install/update would make Chrome
// disable the extension for every existing user until they accept. The modal offers it instead.

import { z } from "zod";
import { FINAL_EXAMS_FALLBACK, FINAL_EXAMS_FALLBACK_SOURCE } from "@/extension/finalExamsFallback";
import { parseFinalExamSchedule, termSlug, type PublishedTermExams } from "@/extension/finalExamsParse";

import { type FinalExamsPageResponse } from "@/extension/finalExamsMessages";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LOG_PREFIX = "[USC Schedule Helper] final exams:";

const slotSchema = z.object({ date: z.string(), start: z.string(), end: z.string() });
const rangeSchema = z.object({ start: z.string(), end: z.string() });
const gridRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("family"),
    label: z.string(),
    family: z.enum(["MWF", "TTh"]),
    startTimes: z.array(z.string()),
    exactRanges: z.array(rangeSchema),
    slot: slotSchema,
  }),
  z.object({
    kind: z.literal("eveningPair"),
    label: z.string(),
    days: z.array(z.string()),
    start: z.string(),
    slot: slotSchema,
  }),
  z.object({
    kind: z.literal("firstMeeting"),
    label: z.string(),
    minStart: z.string(),
    maxStartExclusive: z.string().nullable(),
    onceWeekly: z.boolean(),
    examTime: rangeSchema,
  }),
  z.object({
    kind: z.literal("saturday"),
    label: z.string(),
    half: z.enum(["morning", "afternoon"]),
    slot: slotSchema,
  }),
  z.object({
    kind: z.literal("policy"),
    label: z.string(),
    policy: z.enum(["sameAsFamily", "lectureAndLab", "labWithoutLecture", "irregularTime", "conflicts"]),
  }),
]);
const publishedTermSchema = z.object({
  termId: z.string(),
  finalsStart: z.string(),
  finalsEnd: z.string(),
  grid: z.array(gridRuleSchema),
  exceptions: z.array(z.object({ label: z.string(), courses: z.array(z.string()), slot: slotSchema })),
  unparsedRows: z.array(z.string()),
  unparsedExceptionNumbers: z.array(z.string()),
});
const cacheEntrySchema = z.object({ fetchedAt: z.number(), data: publishedTermSchema });
export type FinalExamsCacheEntry = z.infer<typeof cacheEntrySchema>;

export type FinalExamsDataSource = "live" | "cache" | "fallback";

export type FinalExamsDataResult =
  | {
      status: "published";
      data: PublishedTermExams;
      source: FinalExamsDataSource;
      fetchedAt: number | null; // null for bundled data
      needsPermission: boolean;
    }
  | { status: "unpublished"; termId: string; needsPermission: boolean; checkedLive: boolean };

export interface FinalExamsDataDependencies {
  now: () => number;
  readCache: (key: string) => Promise<FinalExamsCacheEntry | null>;
  writeCache: (key: string, entry: FinalExamsCacheEntry) => Promise<void>;
  requestPage: () => Promise<FinalExamsPageResponse>;
  parseHtml: (html: string) => Document;
  warn: (message: string) => void;
}

export function finalExamsCacheKey(termId: string): string {
  return `local:finalExams:v1:${termId}`;
}

export function parseCacheEntry(value: FinalExamsCacheEntry | null | undefined): FinalExamsCacheEntry | null {
  const parsed = cacheEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function bundledFinalExams(termId: string): PublishedTermExams | null {
  return FINAL_EXAMS_FALLBACK.find((term) => term.termId === termId) ?? null;
}

export async function loadFinalExamData(
  termId: string,
  deps: FinalExamsDataDependencies,
  forceRefresh = false,
): Promise<FinalExamsDataResult> {
  if (!termSlug(termId)) {
    return { status: "unpublished", termId, needsPermission: false, checkedLive: false };
  }

  const key = finalExamsCacheKey(termId);
  let cached: FinalExamsCacheEntry | null = null;
  try {
    cached = parseCacheEntry(await deps.readCache(key));
  } catch (error) {
    deps.warn(`${LOG_PREFIX} cache read failed (${String(error)})`);
  }
  if (cached && !forceRefresh && deps.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      status: "published",
      data: cached.data,
      source: "cache",
      fetchedAt: cached.fetchedAt,
      needsPermission: false,
    };
  }

  let needsPermission = false;
  let checkedLive = false;
  try {
    const page = await deps.requestPage();
    if (!page.ok) {
      needsPermission = page.reason === "permission";
      // A missing optional permission is a normal state the modal already explains; only real
      // failures are logged (Chrome lists every console.warn from an extension on its Errors page).
      if (!needsPermission) {
        deps.warn(
          `${LOG_PREFIX} live page unavailable (${page.reason}: ${page.error}); using ${cached ? "cached" : "bundled"} data.`,
        );
      }
    } else {
      checkedLive = true;
      const result = parseFinalExamSchedule(deps.parseHtml(page.html), termId);
      if (result.ok) {
        if (result.data.unparsedRows.length > 0) {
          deps.warn(`${LOG_PREFIX} skipped rows it couldn't read: ${result.data.unparsedRows.join(" ; ")}`);
        }
        const entry = { fetchedAt: deps.now(), data: result.data };
        try {
          await deps.writeCache(key, entry);
        } catch (error) {
          deps.warn(`${LOG_PREFIX} cache write failed (${String(error)})`);
        }
        return {
          status: "published",
          data: result.data,
          source: "live",
          fetchedAt: entry.fetchedAt,
          needsPermission: false,
        };
      }
      deps.warn(`${LOG_PREFIX} couldn't parse the live page: ${result.error}`);
    }
  } catch (error) {
    deps.warn(`${LOG_PREFIX} live fetch failed (${String(error)}); using ${cached ? "cached" : "bundled"} data.`);
  }

  if (cached) {
    return { status: "published", data: cached.data, source: "cache", fetchedAt: cached.fetchedAt, needsPermission };
  }
  const bundled = bundledFinalExams(termId);
  if (bundled) {
    return { status: "published", data: bundled, source: "fallback", fetchedAt: null, needsPermission };
  }
  return { status: "unpublished", termId, needsPermission, checkedLive };
}

export const BUNDLED_SOURCE_LABEL = FINAL_EXAMS_FALLBACK_SOURCE.replace(/^finalExamSchedule-|\.html$/g, "");
