import assert from "node:assert/strict";
import test from "node:test";
import {
  LOAD_USC_CALENDAR_METADATA,
  USC_ACADEMIC_CALENDAR_URL,
  calendarMetadataRequestSchema,
  loadUSCCalendarMetadata,
  type CalendarMetadataRequest,
} from "@/extension/uscCalendarMetadata";

const REQUEST: CalendarMetadataRequest = {
  type: LOAD_USC_CALENDAR_METADATA,
  termId: "20263",
  sections: [
    { id: "29903", course: "CSCI 104", sessionId: "001" },
    { id: "29933", course: "CSCI 104", sessionId: "001" },
    { id: "14470", course: "BUAD 100", sessionId: "928" },
  ],
};

const COURSES = new Map([
  [
    "CSCI-104",
    {
      sections: [
        {
          sisSectionId: "29903",
          rnrSessionId: 36847,
          session: { termCode: "20263", rnrSessionCode: "001", rnrSessionId: 36847 },
        },
        {
          sisSectionId: "29933",
          rnrSessionId: 36847,
          session: { termCode: "20263", rnrSessionCode: "001", rnrSessionId: 36847 },
        },
      ],
    },
  ],
  [
    "BUAD-100",
    {
      sections: [
        {
          sisSectionId: "14470",
          rnrSessionId: 37743,
          session: { termCode: "20263", rnrSessionCode: "928", rnrSessionId: 37743 },
        },
      ],
    },
  ],
]);

const SESSIONS = new Map([
  [
    "36847",
    {
      termCode: "20263",
      rnrSessionCode: "001",
      rnrSessionId: 36847,
      classBeginDbDate: "2026-08-24T00:00:00Z",
      classEndDbDate: "2026-12-04T00:00:00Z",
      break1BeginDbDate: "2026-11-25T00:00:00Z",
      break1EndDbDate: "2026-11-29T00:00:00Z",
      break2BeginDbDate: null,
      break2EndDbDate: null,
    },
  ],
  [
    "37743",
    {
      termCode: "20263",
      rnrSessionCode: "928",
      rnrSessionId: 37743,
      classBeginDbDate: "2026-09-14T00:00:00Z",
      classEndDbDate: "2026-10-26T00:00:00Z",
      break1BeginDbDate: null,
      break1EndDbDate: null,
      break2BeginDbDate: null,
      break2EndDbDate: null,
    },
  ],
]);

interface FetchOverrides {
  session001Code?: string;
  session001EndDate?: string;
  session001BreakBeginDate?: string;
  session001BreakEndDate?: string;
}

function createFetch(overrides: FetchOverrides = {}) {
  const calls: Array<{ url: string; credentials: RequestCredentials | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url: url.toString(), credentials: init?.credentials });

    if (url.toString() === USC_ACADEMIC_CALENDAR_URL) {
      return new Response("<html>academic calendar</html>", { status: 200 });
    }
    if (url.pathname === "/api/Courses/Course") {
      const course = COURSES.get(url.searchParams.get("courseCode") ?? "");
      return new Response(JSON.stringify(course ?? { sections: null }), { status: 200 });
    }
    if (url.pathname === "/api/Pe/SessionByRnrSessionId") {
      const apiId = url.searchParams.get("rnrSessionId") ?? "";
      const session = SESSIONS.get(apiId);
      const value =
        apiId === "36847" && session
          ? {
              ...session,
              rnrSessionCode: overrides.session001Code ?? session.rnrSessionCode,
              classEndDbDate: overrides.session001EndDate ?? session.classEndDbDate,
              break1BeginDbDate: overrides.session001BreakBeginDate ?? session.break1BeginDbDate,
              break1EndDbDate: overrides.session001BreakEndDate ?? session.break1EndDbDate,
            }
          : session;
      return new Response(JSON.stringify(value), { status: value ? 200 : 404 });
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

test("calendarMetadataRequestSchema accepts only the narrow validated message shape", () => {
  assert.equal(calendarMetadataRequestSchema.safeParse(REQUEST).success, true);
  assert.equal(calendarMetadataRequestSchema.safeParse({ ...REQUEST, termId: "20264" }).success, false);
  assert.equal(calendarMetadataRequestSchema.safeParse({ ...REQUEST, sections: [] }).success, false);
  assert.equal(
    calendarMetadataRequestSchema.safeParse({
      ...REQUEST,
      sections: [{ id: "../secrets", course: "CSCI 104", sessionId: "001" }],
    }).success,
    false,
  );
});

test("loadUSCCalendarMetadata resolves exact per-section sessions and deduplicates network calls", async () => {
  const { calls, fetchImpl } = createFetch();
  const metadata = await loadUSCCalendarMetadata(REQUEST, fetchImpl);

  assert.equal(metadata.academicCalendarHtml, "<html>academic calendar</html>");
  assert.deepEqual(metadata.sessionsBySectionId["14470"], {
    id: "928",
    firstDay: "2026-09-14",
    lastDay: "2026-10-26",
    holidays: [],
  });
  assert.deepEqual(metadata.sessionsBySectionId["29903"], {
    id: "001",
    firstDay: "2026-08-24",
    lastDay: "2026-12-04",
    holidays: [
      { date: "2026-11-25", name: "Session break" },
      { date: "2026-11-26", name: "Session break" },
      { date: "2026-11-27", name: "Session break" },
      { date: "2026-11-28", name: "Session break" },
      { date: "2026-11-29", name: "Session break" },
    ],
  });
  assert.deepEqual(metadata.sessionsBySectionId["29933"], metadata.sessionsBySectionId["29903"]);

  assert.equal(calls.filter((call) => call.url.includes("/api/Courses/Course")).length, 2);
  assert.equal(calls.filter((call) => call.url.includes("/api/Pe/SessionByRnrSessionId")).length, 2);
  assert.ok(calls.every((call) => call.credentials === "omit"));
});

test("loadUSCCalendarMetadata rejects mismatched or incomplete USC session data atomically", async () => {
  const { fetchImpl } = createFetch({ session001Code: "999" });
  await assert.rejects(loadUSCCalendarMetadata(REQUEST, fetchImpl), /mismatched data for session 001/);

  const missingSection = {
    ...REQUEST,
    sections: [{ id: "99999", course: "CSCI 104", sessionId: "001" }],
  };
  await assert.rejects(loadUSCCalendarMetadata(missingSection, createFetch().fetchImpl), /Could not resolve/);
});

test("loadUSCCalendarMetadata rejects implausible session bounds and out-of-range breaks", async () => {
  await assert.rejects(
    loadUSCCalendarMetadata(REQUEST, createFetch({ session001EndDate: "2027-12-04T00:00:00Z" }).fetchImpl),
    /implausible dates for session 001/,
  );

  await assert.rejects(
    loadUSCCalendarMetadata(
      REQUEST,
      createFetch({
        session001BreakBeginDate: "2026-08-01T00:00:00Z",
        session001BreakEndDate: "2026-08-02T00:00:00Z",
      }).fetchImpl,
    ),
    /out-of-range break for session 001/,
  );
});
