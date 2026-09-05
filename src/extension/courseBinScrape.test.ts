import assert from "node:assert/strict";
import test from "node:test";
import { parseDays, parseTimeRange, expandLocation, COURSE_BIN_URL } from "@/extension/courseBinScrape";

// The real server route is /CourseBin (capital C, capital B, no "my" prefix) — the nav link's
// display text and the post-load browser URL both read "myCourseBin", which is what caused the
// fetch to originally target the wrong, 404-ing path. Pinned here as its own assertion, not
// folded into the parser tests above, because a hardcoded typo in calendarExport.ts wouldn't be
// caught by any test that only exercises the scraping logic given already-correct input.
test("COURSE_BIN_URL targets the real /CourseBin route, not the display-text /myCourseBin", () => {
  assert.equal(COURSE_BIN_URL, "https://webreg.usc.edu/CourseBin");
});

// parseDays

test("parseDays: MWF", () => assert.deepEqual(parseDays("MWF"), ["MO", "WE", "FR"]));

test("parseDays: TTh — Th must be tested before T, or Thursday becomes Tuesday plus garbage", () => {
  assert.deepEqual(parseDays("TTh"), ["TU", "TH"]);
});

test("parseDays: Th alone", () => assert.deepEqual(parseDays("Th"), ["TH"]));
test("parseDays: W alone", () => assert.deepEqual(parseDays("W"), ["WE"]));
test("parseDays: F alone", () => assert.deepEqual(parseDays("F"), ["FR"]));

test("parseDays: Tu/TuTh dialect is also supported, defensively", () => {
  assert.deepEqual(parseDays("Tu"), ["TU"]);
  assert.deepEqual(parseDays("TuTh"), ["TU", "TH"]);
});

test("parseDays: TBA, TBD, and empty all mean async — no days", () => {
  assert.deepEqual(parseDays("TBA"), []);
  assert.deepEqual(parseDays("TBD"), []);
  assert.deepEqual(parseDays(""), []);
  assert.deepEqual(parseDays(undefined), []);
});

test("parseDays: comma and slash separators", () => {
  assert.deepEqual(parseDays("M,W,F"), ["MO", "WE", "FR"]);
  assert.deepEqual(parseDays("M/W/F"), ["MO", "WE", "FR"]);
});

test("parseDays: an unrecognized code throws rather than silently dropping a meeting day", () => {
  assert.throws(() => parseDays("XYZ"));
});

// parseTimeRange

test("parseTimeRange: real /CourseBin strings — meridiem on both ends", () => {
  assert.deepEqual(parseTimeRange("01:00pm-01:50pm"), { start: "13:00", end: "13:50" });
  assert.deepEqual(parseTimeRange("12:30pm-01:50pm"), { start: "12:30", end: "13:50" });
  assert.deepEqual(parseTimeRange("07:00pm-08:50pm"), { start: "19:00", end: "20:50" });
});

test("parseTimeRange: start meridiem inferred from end meridiem", () => {
  assert.deepEqual(parseTimeRange("10:00-11:50am"), { start: "10:00", end: "11:50" });
  assert.deepEqual(parseTimeRange("2:00-3:50pm"), { start: "14:00", end: "15:50" });
  assert.deepEqual(parseTimeRange("8:00am-9:50am"), { start: "08:00", end: "09:50" });
});

test("parseTimeRange: inferred start rolls back 12h when it would otherwise land after the end", () => {
  assert.deepEqual(parseTimeRange("11:00-12:50pm"), { start: "11:00", end: "12:50" });
  assert.deepEqual(parseTimeRange("12:00-1:50pm"), { start: "12:00", end: "13:50" });
});

test("parseTimeRange: spaced dash", () => {
  assert.deepEqual(parseTimeRange("4:00 - 6:40pm"), { start: "16:00", end: "18:40" });
});

test("parseTimeRange: TBA and empty mean async — no time", () => {
  assert.equal(parseTimeRange("TBA"), null);
  assert.equal(parseTimeRange(""), null);
  assert.equal(parseTimeRange(undefined), null);
});

test("parseTimeRange: a range missing the end meridiem throws rather than guessing", () => {
  assert.throws(() => parseTimeRange("10:00-11:50"));
});

test("parseTimeRange: invalid clock values and non-positive durations throw", () => {
  for (const value of ["00:00am-01:00am", "13:00pm-02:00pm", "10:60am-11:50am", "10:00am-11:99am"]) {
    assert.throws(() => parseTimeRange(value), /invalid clock time/);
  }
  assert.throws(() => parseTimeRange("2:00pm-1:00pm"), /must end after it starts/);
  assert.throws(() => parseTimeRange("2:00pm-2:00pm"), /must end after it starts/);
});

// expandLocation

test("expandLocation: real codes from the confirmed fixture data expand to the bare name when there's no room", () => {
  assert.equal(expandLocation("ZHS"), "James H. Zumberge Hall of Science");
  assert.equal(expandLocation("THH"), "Mark Taper Hall of Humanities");
  assert.equal(expandLocation("KAP"), "Kaprielian Hall");
});

test('expandLocation: a fixed 3-letter split leaves the room number attached as "Room, Name", not a lookup miss on 4+ letter codes', () => {
  assert.equal(expandLocation("WPHB27"), "B27, Waite Phillips Hall of Education");
  assert.equal(expandLocation("KAP145"), "145, Kaprielian Hall");
});

test("expandLocation: an unmapped code passes through unchanged, never throws", () => {
  assert.equal(expandLocation("ZZZ123"), "ZZZ123");
});

test("expandLocation: TBD passes through unchanged", () => {
  assert.equal(expandLocation("TBD"), "TBD");
});
