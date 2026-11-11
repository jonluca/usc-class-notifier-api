import assert from "node:assert/strict";
import test from "node:test";
import { findOverlaps, readSectionRow, weeklyMeetings, type SectionRowInfo } from "@/extension/weekSchedule";
import { parseDetachedDocument } from "@/extension/testing/detachedDocument";

const entry = (Title: string, Start: string | Date, End: string | Date) => ({ Title, Start, End });

test("weeklyMeetings converts calendar instants to USC local weekday and time", () => {
  assert.deepEqual(
    weeklyMeetings({
      Data: [
        // 17:00Z on a Monday in August is 10:00 PDT.
        entry("WRIT-340 (66700R)", "2026-08-24T17:00:00Z", "2026-08-24T18:50:00Z"),
        // 22:00Z on a Monday in December is 14:00 PST.
        entry("MATH-407 (39860R)", "2026-12-07T22:00:00Z", "2026-12-07T23:20:00Z"),
        // 06:30Z Tuesday is still Monday 23:30 in Los Angeles.
        entry("LATE-100 (11111R)", "2026-08-25T06:30:00Z", "2026-08-25T06:50:00Z"),
      ],
    }),
    [
      { course: "WRIT-340", section: "66700", day: "Monday", start: "10:00", end: "11:50" },
      { course: "MATH-407", section: "39860", day: "Monday", start: "14:00", end: "15:20" },
      { course: "LATE-100", section: "11111", day: "Monday", start: "23:30", end: "23:50" },
    ],
  );
});

test("weeklyMeetings accepts Microsoft JSON dates and Date objects", () => {
  const start = Date.parse("2026-08-27T21:00:00Z");
  const end = Date.parse("2026-08-27T22:20:00Z");
  const expected = [{ course: "CSCI-270", section: "30040", day: "Thursday", start: "14:00", end: "15:20" }];
  assert.deepEqual(
    weeklyMeetings({ Data: [entry("CSCI-270 (30040R)", `/Date(${start})/`, `/Date(${end})/`)] }),
    expected,
  );
  assert.deepEqual(weeklyMeetings({ Data: [entry("CSCI-270 (30040R)", new Date(start), new Date(end))] }), expected);
  assert.deepEqual(
    weeklyMeetings({ Data: [entry("CSCI-270 (30040R)", `/Date(${start}-0700)/`, `/Date(${end}-0700)/`)] }),
    expected,
    "a timezone suffix on a Microsoft date doesn't change the instant",
  );
});

test("weeklyMeetings collapses repeats across weeks and keeps first-appearance order", () => {
  const weeks = [0, 7, 14, 21];
  const at = (day: number, hour: number) => new Date(Date.UTC(2026, 7, 24 + day, hour + 7)).toISOString();
  const data = weeks.flatMap((offset) => [
    entry("CSCI-270 (30040R)", at(offset + 2, 16), at(offset + 2, 17)),
    entry("CSCI-201 (29901R)", at(offset + 1, 12), at(offset + 1, 13)),
    entry("CSCI-270 (30040R)", at(offset, 16), at(offset, 17)),
  ]);
  assert.deepEqual(
    weeklyMeetings({ Data: data }).map((m) => `${m.course} ${m.day} ${m.start}`),
    ["CSCI-270 Wednesday 16:00", "CSCI-201 Tuesday 12:00", "CSCI-270 Monday 16:00"],
  );
});

test("weeklyMeetings keeps different sections, and different times of the same section on one day", () => {
  const meetings = weeklyMeetings({
    Data: [
      entry("CSCI-104 (29905R)", "2026-08-24T15:00:00Z", "2026-08-24T16:20:00Z"),
      entry("CSCI-104 (29914R)", "2026-08-24T19:00:00Z", "2026-08-24T20:50:00Z"),
      entry("CSCI-104 (29914R)", "2026-08-24T22:00:00Z", "2026-08-24T22:50:00Z"),
    ],
  });
  assert.equal(meetings.length, 3);
});

test("weeklyMeetings skips entries it can't read instead of guessing", () => {
  assert.deepEqual(
    weeklyMeetings({
      Data: [
        entry("NOSECTION", "2026-08-24T17:00:00Z", "2026-08-24T18:00:00Z"),
        entry("CSCI-104 (29905R)", "not a date", "2026-08-24T18:00:00Z"),
        entry("CSCI-104 (29905R)", "2026-08-24T17:00:00Z", "/Date(oops)/"),
      ],
    }),
    [],
  );
  assert.deepEqual(weeklyMeetings({ Data: [] }), []);
  assert.deepEqual(weeklyMeetings(null), []);
  assert.deepEqual(weeklyMeetings(undefined), []);
});

async function sectionElement(rows: Record<string, string>, extra = "") {
  const doc = await parseDetachedDocument(
    `<div class="section">${Object.entries(rows)
      .map(([label, value]) => `<span class="section_row">${label}: ${value}</span>`)
      .join("")}${extra}</div>`,
  );
  return doc.querySelector(".section")!;
}

test("readSectionRow reads WebReg's labelled rows", async () => {
  const info = readSectionRow(
    await sectionElement({ Section: "30379R", Type: "Lab", Days: "Th", Time: "02:00pm-03:50pm" }),
  );
  assert.deepEqual(info, {
    name: "30379R",
    type: "Lab",
    days: ["Thursday"],
    time: { start: "14:00", end: "15:50" },
  });
});

test("readSectionRow handles TTh, noon-crossing times, and padding around values", async () => {
  const info = readSectionRow(
    await sectionElement({ Section: " 29901R ", Type: "Lecture", Days: "TTh", Time: " 11:00-12:20pm " }),
  );
  assert.deepEqual(info.days, ["Tuesday", "Thursday"]);
  assert.deepEqual(info.time, { start: "11:00", end: "12:20" });
  assert.equal(info.name, "29901R");
});

test("readSectionRow reports TBA and missing rows as unknown rather than guessing", async (t) => {
  t.mock.method(console, "error", () => {});
  assert.equal(readSectionRow(await sectionElement({ Section: "1R", Days: "", Time: "TBA" })).time, null);
  const bare = readSectionRow(await sectionElement({}));
  assert.deepEqual(bare, { name: "", type: undefined, days: [], time: null });
});

test("readSectionRow ignores note text that merely mentions timing", async () => {
  const info = readSectionRow(
    await sectionElement(
      { Section: "29905R", Type: "Lecture", Days: "MW", Time: "08:00am-09:20am" },
      `<span class="section_row">This section is changing timing to MonWed 2:00-3:20PM.</span>`,
    ),
  );
  assert.deepEqual(info.time, { start: "08:00", end: "09:20" });
});

const meeting = (course: string, section: string, day: string, start: string, end: string) => ({
  course,
  section,
  day,
  start,
  end,
});
const section = (overrides: Partial<SectionRowInfo>): SectionRowInfo => ({
  name: "30379R",
  type: "Lab",
  days: ["Thursday"],
  time: { start: "14:00", end: "15:50" },
  ...overrides,
});

test("findOverlaps returns every overlap in calendar order", () => {
  const meetings = [
    meeting("MATH-407", "39860", "Thursday", "14:00", "15:20"),
    meeting("CSCI-201", "29901", "Thursday", "12:30", "13:50"),
    meeting("EE-109", "31200", "Thursday", "15:30", "16:50"),
  ];
  assert.deepEqual(
    findOverlaps(section({}), meetings).map((m) => m.course),
    ["MATH-407", "EE-109"],
  );
});

test("findOverlaps: touching endpoints, other days, your own section and unknown times don't overlap", () => {
  assert.deepEqual(findOverlaps(section({}), [meeting("A-1", "1", "Thursday", "15:50", "17:00")]), []);
  assert.deepEqual(findOverlaps(section({}), [meeting("A-1", "1", "Thursday", "12:00", "14:00")]), []);
  assert.deepEqual(findOverlaps(section({}), [meeting("A-1", "1", "Tuesday", "14:00", "15:00")]), []);
  assert.deepEqual(findOverlaps(section({}), [meeting("CSCI-104", "30379", "Thursday", "14:00", "15:50")]), []);
  assert.deepEqual(findOverlaps(section({ time: null }), [meeting("A-1", "1", "Thursday", "14:00", "15:00")]), []);
});

test("findOverlaps: a class fully inside, or fully around, the section overlaps", () => {
  assert.equal(findOverlaps(section({}), [meeting("A-1", "1", "Thursday", "14:30", "15:00")]).length, 1);
  assert.equal(findOverlaps(section({}), [meeting("A-1", "1", "Thursday", "13:00", "17:00")]).length, 1);
});

test("weeklyMeetings never merges different classes whose fields contain separator characters", () => {
  const meetings = weeklyMeetings({
    Data: [
      entry("A|B (CXY", "2026-08-24T17:00:00Z", "2026-08-24T18:20:00Z"),
      entry("A (B|CXY", "2026-08-24T17:00:00Z", "2026-08-24T18:20:00Z"),
    ],
  });
  assert.deepEqual(
    meetings.map((m) => [m.course, m.section]),
    [
      ["A|B", "C"],
      ["A", "B|C"],
    ],
  );
});

test("readSectionRow throws on a malformed time rather than guessing", async () => {
  const element = await sectionElement({ Section: "1R", Days: "M", Time: "bad time" });
  assert.throws(() => readSectionRow(element));
});
