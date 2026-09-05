import pMap from "p-map";
import { z } from "zod";
import type { Holiday, SectionSession } from "@/extension/ics";

export const LOAD_USC_CALENDAR_METADATA = "usc-calendar:load-metadata";
export const USC_ACADEMIC_CALENDAR_URL = "https://www.usc.edu/academic-calendar/";
const USC_CLASSES_API = "https://classes.usc.edu/api";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_SESSION_DAYS = 200;
const FETCH_CONCURRENCY = 6;

const sectionReferenceSchema = z.object({
  id: z.string().regex(/^\d{5}$/),
  course: z.string().regex(/^[A-Z]{2,10} \d{1,4}[A-Z]{0,3}$/),
  sessionId: z.string().regex(/^\d{3}$/),
});

export const calendarMetadataRequestSchema = z.object({
  type: z.literal(LOAD_USC_CALENDAR_METADATA),
  termId: z.string().regex(/^\d{4}[123]$/),
  sections: z.array(sectionReferenceSchema).min(1).max(100),
});

const holidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string(),
});

const sectionSessionSchema = z.object({
  id: z.string().regex(/^\d{3}$/),
  firstDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  holidays: z.array(holidaySchema).optional(),
});

const calendarMetadataSchema = z.object({
  academicCalendarHtml: z.string(),
  sessionsBySectionId: z.record(z.string(), sectionSessionSchema),
});

export const calendarMetadataResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), metadata: calendarMetadataSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type CalendarSectionReference = z.infer<typeof sectionReferenceSchema>;
export type CalendarMetadataRequest = z.infer<typeof calendarMetadataRequestSchema>;
export type CalendarMetadata = z.infer<typeof calendarMetadataSchema>;
export type CalendarMetadataResponse = z.infer<typeof calendarMetadataResponseSchema>;

const courseResponseSchema = z.object({
  sections: z
    .array(
      z.object({
        sisSectionId: z.string(),
        rnrSessionId: z.number().int().positive(),
        session: z.object({
          termCode: z.string(),
          rnrSessionCode: z.string(),
          rnrSessionId: z.number().int().positive(),
        }),
      }),
    )
    .nullable(),
});

const optionalApiDateSchema = z.string().nullable().optional();
const sessionResponseSchema = z.object({
  termCode: z.string(),
  rnrSessionCode: z.string(),
  rnrSessionId: z.number().int().positive(),
  classBeginDbDate: z.string(),
  classEndDbDate: z.string(),
  break1BeginDbDate: optionalApiDateSchema,
  break1EndDbDate: optionalApiDateSchema,
  break2BeginDbDate: optionalApiDateSchema,
  break2EndDbDate: optionalApiDateSchema,
});

type FetchImplementation = typeof fetch;

function isoDatePrefix(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`USC returned an invalid ${field}.`);
  }
  const iso = value.slice(0, 10);
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`USC returned an invalid ${field}.`);
  }
  return iso;
}

function expandBreak(begin: string | null | undefined, end: string | null | undefined, name: string): Holiday[] {
  if (begin == null && end == null) {
    return [];
  }
  if (begin == null || end == null) {
    throw new Error(`USC returned an incomplete ${name}.`);
  }

  const firstDay = isoDatePrefix(begin, `${name} start date`);
  const lastDay = isoDatePrefix(end, `${name} end date`);
  if (firstDay > lastDay) {
    throw new Error(`USC returned an inverted ${name}.`);
  }

  const holidays: Holiday[] = [];
  const lastTimestamp = Date.parse(`${lastDay}T00:00:00Z`);
  for (let timestamp = Date.parse(`${firstDay}T00:00:00Z`); timestamp <= lastTimestamp; timestamp += 86_400_000) {
    if (holidays.length >= 370) {
      throw new Error(`USC returned an implausibly long ${name}.`);
    }
    holidays.push({ date: new Date(timestamp).toISOString().slice(0, 10), name: "Session break" });
  }
  return holidays;
}

async function fetchText(url: URL | string, fetchImpl: FetchImplementation): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      credentials: "omit",
      headers: { Accept: "application/json, text/html;q=0.9" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`USC calendar data request failed with status ${response.status}.`);
    }
    return response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJSON<T>(url: URL, schema: z.ZodType<T>, fetchImpl: FetchImplementation): Promise<T> {
  const text = await fetchText(url, fetchImpl);
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new Error("USC returned malformed or unexpected calendar data.");
  }
}

interface ResolvedSectionSession {
  sectionId: string;
  apiId: number;
  sessionId: string;
}

async function resolveCourseSections(
  termId: string,
  course: string,
  references: CalendarSectionReference[],
  fetchImpl: FetchImplementation,
): Promise<ResolvedSectionSession[]> {
  const url = new URL(`${USC_CLASSES_API}/Courses/Course`);
  url.searchParams.set("termCode", termId);
  url.searchParams.set("courseCode", course.replace(" ", "-"));
  const courseData = await fetchJSON(url, courseResponseSchema, fetchImpl);
  const courseSections = courseData.sections;
  if (!courseSections) {
    throw new Error(`USC returned no sections for ${course}.`);
  }

  return references.map((reference) => {
    const match = courseSections.find((candidate) => candidate.sisSectionId === reference.id);
    if (!match) {
      throw new Error(`Could not resolve ${course} section ${reference.id}.`);
    }

    if (
      match.session.rnrSessionId !== match.rnrSessionId ||
      match.session.rnrSessionCode !== reference.sessionId ||
      match.session.termCode !== termId
    ) {
      throw new Error(`USC session metadata did not match ${course} section ${reference.id}.`);
    }

    return {
      sectionId: reference.id,
      apiId: match.rnrSessionId,
      sessionId: match.session.rnrSessionCode,
    };
  });
}

async function fetchSession(
  termId: string,
  apiId: number,
  expectedSessionId: string,
  fetchImpl: FetchImplementation,
): Promise<SectionSession> {
  const url = new URL(`${USC_CLASSES_API}/Pe/SessionByRnrSessionId`);
  url.searchParams.set("rnrSessionId", String(apiId));
  const data = await fetchJSON(url, sessionResponseSchema, fetchImpl);
  if (data.termCode !== termId || data.rnrSessionCode !== expectedSessionId || data.rnrSessionId !== apiId) {
    throw new Error(`USC returned mismatched data for session ${expectedSessionId}.`);
  }

  const firstDay = isoDatePrefix(data.classBeginDbDate, "class begin date");
  const lastDay = isoDatePrefix(data.classEndDbDate, "class end date");
  if (firstDay > lastDay) {
    throw new Error(`USC returned inverted dates for session ${expectedSessionId}.`);
  }
  const termYear = termId.slice(0, 4);
  const durationDays = (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000 + 1;
  if (!firstDay.startsWith(`${termYear}-`) || !lastDay.startsWith(`${termYear}-`) || durationDays > MAX_SESSION_DAYS) {
    throw new Error(`USC returned implausible dates for session ${expectedSessionId}.`);
  }

  const holidays = [
    ...expandBreak(data.break1BeginDbDate, data.break1EndDbDate, "first session break"),
    ...expandBreak(data.break2BeginDbDate, data.break2EndDbDate, "second session break"),
  ];
  if (holidays.some((holiday) => holiday.date < firstDay || holiday.date > lastDay)) {
    throw new Error(`USC returned an out-of-range break for session ${expectedSessionId}.`);
  }
  return { id: expectedSessionId, firstDay, lastDay, holidays };
}

export async function loadUSCCalendarMetadata(
  request: CalendarMetadataRequest,
  fetchImpl: FetchImplementation = fetch,
): Promise<CalendarMetadata> {
  const byCourse = new Map<string, CalendarSectionReference[]>();
  for (const section of request.sections) {
    const references = byCourse.get(section.course) ?? [];
    references.push(section);
    byCourse.set(section.course, references);
  }

  const [academicCalendarHtml, resolvedGroups] = await Promise.all([
    fetchText(USC_ACADEMIC_CALENDAR_URL, fetchImpl),
    pMap(byCourse, ([course, references]) => resolveCourseSections(request.termId, course, references, fetchImpl), {
      concurrency: FETCH_CONCURRENCY,
    }),
  ]);
  const resolvedSections = resolvedGroups.flat();

  const uniqueSessions = new Map<number, ResolvedSectionSession>();
  for (const resolved of resolvedSections) {
    const existing = uniqueSessions.get(resolved.apiId);
    if (existing && existing.sessionId !== resolved.sessionId) {
      throw new Error(`USC returned inconsistent data for session ${resolved.sessionId}.`);
    }
    uniqueSessions.set(resolved.apiId, resolved);
  }

  const sessionsByApiId = new Map<number, SectionSession>();
  await pMap(
    uniqueSessions,
    async ([apiId, resolved]) => {
      const session = await fetchSession(request.termId, apiId, resolved.sessionId, fetchImpl);
      sessionsByApiId.set(apiId, session);
    },
    { concurrency: FETCH_CONCURRENCY },
  );

  const sessionsBySectionId: Record<string, SectionSession> = {};
  for (const resolved of resolvedSections) {
    const session = sessionsByApiId.get(resolved.apiId);
    if (!session || session.id !== resolved.sessionId) {
      throw new Error(`USC returned no data for session ${resolved.sessionId}.`);
    }
    sessionsBySectionId[resolved.sectionId] = session;
  }

  return { academicCalendarHtml, sessionsBySectionId };
}

export function calendarMetadataError(cause: unknown): CalendarMetadataResponse {
  return {
    ok: false,
    error: cause instanceof Error ? cause.message : "USC calendar metadata could not be loaded.",
  };
}
