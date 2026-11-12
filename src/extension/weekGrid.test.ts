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
