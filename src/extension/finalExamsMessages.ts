// Messages between the WebReg content script and the background worker for the final-exam feature,
// plus the background-side fetch. Kept free of the parser and bundled data so the service worker
// bundle stays small.
import { z } from "zod";
import { FINAL_EXAM_SCHEDULE_URL } from "@/extension/finalExamsParse";

export const LOAD_FINAL_EXAMS_PAGE = "final-exams:load-page";
export const OPEN_FINAL_EXAMS_PERMISSION = "final-exams:open-permission";
export const FINAL_EXAMS_ORIGIN = "https://arr.usc.edu/*";
export const FINAL_EXAMS_PERMISSION_PAGE = "/final-exams-permission.html";
// Written by the permission page after a grant so open WebReg tabs know to reload exam data.
export const FINAL_EXAMS_PERMISSION_CHANGED_KEY = "local:finalExams:permissionChangedAt";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 2_000_000;

export const finalExamsPageRequestSchema = z.object({ type: z.literal(LOAD_FINAL_EXAMS_PAGE) });
export const openFinalExamsPermissionSchema = z.object({ type: z.literal(OPEN_FINAL_EXAMS_PERMISSION) });

export const finalExamsPageResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), html: z.string() }),
  z.object({ ok: z.literal(false), reason: z.enum(["permission", "network"]), error: z.string() }),
]);
export type FinalExamsPageResponse = z.infer<typeof finalExamsPageResponseSchema>;

export interface PermissionsApi {
  contains: (permissions: { origins: string[] }) => Promise<boolean>;
}

export async function fetchFinalExamsPage(
  permissions: PermissionsApi,
  fetchImpl: typeof fetch = fetch,
): Promise<FinalExamsPageResponse> {
  if (!(await permissions.contains({ origins: [FINAL_EXAMS_ORIGIN] }))) {
    return { ok: false, reason: "permission", error: "arr.usc.edu access hasn't been granted." };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(FINAL_EXAM_SCHEDULE_URL, {
      credentials: "omit",
      headers: { Accept: "text/html" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, reason: "network", error: `HTTP ${response.status}` };
    }
    if (response.url && new URL(response.url).origin !== "https://arr.usc.edu") {
      return { ok: false, reason: "network", error: `redirected to ${new URL(response.url).origin}` };
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_PAGE_BYTES) {
      return { ok: false, reason: "network", error: "response too large" };
    }
    const html = await response.text();
    if (html.length > MAX_PAGE_BYTES) {
      return { ok: false, reason: "network", error: "response too large" };
    }
    return { ok: true, html };
  } catch (error) {
    return { ok: false, reason: "network", error: error instanceof Error ? error.message : "request failed" };
  } finally {
    clearTimeout(timeoutId);
  }
}
