import assert from "node:assert/strict";
import test from "node:test";
import { buildWeekGrid, formatTimeRange } from "@/extension/weekGrid";
import type { WeeklyMeeting } from "@/extension/weekSchedule";

const m = (course: string, day: string, start: string, end: string, section = "1"): WeeklyMeeting => ({
  course,
  section,
  day,
  start,
  end,
});

test("an ordinary week shows Mon–Fri, 8 AM to 6 PM, with blocks placed by time", () => {
  const grid = buildWeekGrid([m("MATH-407", "Tuesday", "14:00", "15:20")], 30);
  assert.deepEqual(grid.shortDays, ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  assert.equal(grid.startHour, 8);
  assert.equal(grid.endHour, 18);
  assert.equal(grid.height, 300);
  assert.deepEqual(
    grid.blocks.map(({ course, dayIndex, top, height, lane, lanes, timeLabel }) => ({
      course,
      dayIndex,
      top,
      height,
      lane,
      lanes,
      timeLabel,
    })),
    [{ course: "MATH-407", dayIndex: 1, top: 180, height: 40, lane: 0, lanes: 1, timeLabel: "2:00–3:20 PM" }],
  );
});

test("the hours stretch to fit early and late classes (e.g. a 7 PM quiz)", () => {
  const grid = buildWeekGrid([m("A-1", "Monday", "07:30", "08:20"), m("CSCI-104", "Thursday", "19:00", "20:50")], 30);
  assert.equal(grid.startHour, 7);
  assert.equal(grid.endHour, 21);
  assert.equal(grid.blocks.find((b) => b.course === "A-1")!.top, 15);
  assert.equal(grid.hourMarks[0]!.label, "7a");
  assert.equal(grid.hourMarks.at(-1)!.label, "9p");
});

test("Saturday and Sunday columns appear only when a class meets then, in week order", () => {
  assert.deepEqual(buildWeekGrid([m("A-1", "Saturday", "10:00", "11:00")]).shortDays, [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
  ]);
  const both = buildWeekGrid([m("A-1", "Sunday", "10:00", "11:00"), m("B-1", "Saturday", "10:00", "11:00")]);
  assert.deepEqual(both.days.slice(5), ["Saturday", "Sunday"]);
  assert.equal(both.blocks.find((b) => b.course === "A-1")!.dayIndex, 6);
});

test("classes that overlap on the same day sit side by side", () => {
  const grid = buildWeekGrid([
    m("WRIT-340", "Monday", "10:00", "11:50"),
    m("MATH-226", "Monday", "11:00", "11:50"),
    m("LATER-1", "Monday", "13:00", "13:50"),
  ]);
  const lanes = Object.fromEntries(grid.blocks.map((b) => [b.course, [b.lane, b.lanes]]));
  assert.deepEqual(lanes, { "WRIT-340": [0, 2], "MATH-226": [1, 2], "LATER-1": [0, 1] });
});

test("back-to-back classes (one ends as the next starts) each get the full column", () => {
  const grid = buildWeekGrid([m("A-1", "Monday", "10:00", "11:00"), m("B-1", "Monday", "11:00", "12:00")]);
  assert.deepEqual(
    grid.blocks.map((b) => b.lanes),
    [1, 1],
  );
});

test("a chain of overlaps reuses a freed lane and keeps one width for the whole chain", () => {
  const grid = buildWeekGrid([
    m("A-1", "Monday", "10:00", "11:00"),
    m("B-1", "Monday", "10:30", "11:30"),
    m("C-1", "Monday", "11:00", "12:00"),
  ]);
  const lanes = Object.fromEntries(grid.blocks.map((b) => [b.course, [b.lane, b.lanes]]));
  assert.deepEqual(lanes, { "A-1": [0, 2], "B-1": [1, 2], "C-1": [0, 2] });
});

test("the same class on different days gets one block per day", () => {
  const grid = buildWeekGrid([m("CSCI-270", "Monday", "16:00", "17:20"), m("CSCI-270", "Wednesday", "16:00", "17:20")]);
  assert.deepEqual(
    grid.blocks.map((b) => b.dayIndex),
    [0, 2],
  );
  assert.equal(new Set(grid.blocks.map((b) => b.key)).size, 2);
});

test("meetings that can't be drawn are left out instead of breaking the grid", () => {
  const grid = buildWeekGrid([m("BAD-1", "Monday", "11:00", "10:00"), m("BAD-2", "Funday", "10:00", "11:00")]);
  assert.equal(grid.blocks.length, 0);
  assert.equal(grid.startHour, 8);
});

test("time labels", () => {
  assert.equal(formatTimeRange("16:00", "17:20"), "4:00–5:20 PM");
  assert.equal(formatTimeRange("11:00", "12:20"), "11:00 AM–12:20 PM");
  assert.equal(formatTimeRange("08:00", "09:20"), "8:00–9:20 AM");
  assert.equal(formatTimeRange("12:00", "12:50"), "12:00–12:50 PM");
});

test("a class starting exactly as an overlapping pair ends gets the full column again", () => {
  const grid = buildWeekGrid([
    m("A-1", "Monday", "10:00", "11:00"),
    m("B-1", "Monday", "10:30", "11:00"),
    m("C-1", "Monday", "11:00", "12:00"),
  ]);
  const lanes = Object.fromEntries(grid.blocks.map((b) => [b.course, [b.lane, b.lanes]]));
  assert.deepEqual(lanes, { "A-1": [0, 2], "B-1": [1, 2], "C-1": [0, 1] });
});

const lab = (days: string[], start: string, end: string) => ({
  course: "CSCI-104",
  name: "30379 R",
  meetings: [{ days, time: { start, end } }],
});
const thursdayLab = lab(["Thursday"], "14:00", "15:50");
const kinds = (grid: ReturnType<typeof buildWeekGrid>) =>
  grid.blocks.map((b) => `${b.course} ${grid.shortDays[b.dayIndex]} ${b.kind} ${b.lane}/${b.lanes}`).sort();

test("a section that fits is drawn as a preview on its days, and nothing else changes", () => {
  const grid = buildWeekGrid([m("CSCI-201", "Tuesday", "12:30", "13:50", "29901")], 30, thursdayLab);
  assert.deepEqual(kinds(grid), ["CSCI-104 Thu preview 0/1", "CSCI-201 Tue scheduled 0/1"]);
  assert.deepEqual(grid.preview, { overlaps: [], alreadyScheduled: false });
});

test("an overlap marks your class and the preview on that day, side by side, your class on the left", () => {
  const math = m("MATH-407", "Thursday", "14:00", "15:20", "39860");
  const mathTue = m("MATH-407", "Tuesday", "14:00", "15:20", "39860");
  const grid = buildWeekGrid([mathTue, math], 30, lab(["Tuesday", "Thursday"], "15:30", "16:00"));
  assert.deepEqual(grid.preview?.overlaps, []);
  const overlapping = buildWeekGrid([mathTue, math], 30, lab(["Thursday", "Friday"], "14:00", "15:50"));
  assert.deepEqual(overlapping.preview?.overlaps, [math]);
  assert.deepEqual(kinds(overlapping), [
    "CSCI-104 Fri preview 0/1",
    "CSCI-104 Thu previewOverlap 1/2",
    "MATH-407 Thu overlapped 0/2",
    "MATH-407 Tue scheduled 0/1",
  ]);
});

test("touching endpoints aren't an overlap for the preview either", () => {
  const grid = buildWeekGrid([m("MATH-407", "Thursday", "12:30", "14:00", "39860")], 30, thursdayLab);
  assert.deepEqual(grid.preview?.overlaps, []);
});

test("a section already on your calendar isn't drawn twice", () => {
  const grid = buildWeekGrid([m("CSCI-104", "Thursday", "14:00", "15:50", "30379")], 30, thursdayLab);
  assert.deepEqual(grid.preview, { overlaps: [], alreadyScheduled: true });
  assert.deepEqual(kinds(grid), ["CSCI-104 Thu scheduled 0/1"]);
});

test("the grid stretches to show a previewed evening section", () => {
  const grid = buildWeekGrid([], 30, lab(["Thursday"], "19:00", "20:50"));
  assert.equal(grid.endHour, 21);
  assert.equal(grid.blocks[0]!.kind, "preview");
});

test("a preview without a course code is still drawn, labelled 'Section'", () => {
  const grid = buildWeekGrid([], 30, { ...thursdayLab, course: "" });
  assert.equal(grid.blocks[0]!.course, "Section");
});

test("when the preview starts with your class, the preview is drawn to its right even if it's shorter", () => {
  const grid = buildWeekGrid(
    [m("MATH-407", "Thursday", "14:00", "15:20", "39860")],
    30,
    lab(["Thursday"], "14:00", "14:50"),
  );
  assert.deepEqual(kinds(grid), ["CSCI-104 Thu previewOverlap 1/2", "MATH-407 Thu overlapped 0/2"]);
});

test("a section with two meeting patterns is drawn at both, and each is checked for overlaps", () => {
  const math = m("MATH-407", "Wednesday", "14:00", "15:20", "39860");
  const grid = buildWeekGrid([math], 30, {
    course: "ARCH-202",
    name: "11111 R",
    meetings: [
      { days: ["Monday"], time: { start: "13:00", end: "17:50" } },
      { days: ["Wednesday"], time: { start: "14:00", end: "15:50" } },
    ],
  });
  assert.deepEqual(grid.preview?.overlaps, [math]);
  assert.deepEqual(kinds(grid), [
    "ARCH-202 Mon preview 0/1",
    "ARCH-202 Wed previewOverlap 1/2",
    "MATH-407 Wed overlapped 0/2",
  ]);
});
