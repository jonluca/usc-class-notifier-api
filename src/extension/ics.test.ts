import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeText,
  foldLine,
  unfoldLines,
  firstOccurrenceOnOrAfter,
  utcOffsetHours,
  generateICS,
  countExportableMeetings,
  type Schedule,
} from "@/extension/ics";

const CRLF = "\r\n";
const GENERATED_AT = new Date("2026-08-01T12:34:56.789Z");

function octetLen(str: string) {
  return new TextEncoder().encode(str).length;
}

function physicalLines(icsText: string) {
  const lines = icsText.split(CRLF);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// Representative Fall 2026 input used to exercise recurrence, timezone, and holiday behavior.
const fixtureSchedule: Schedule = {
  term: {
    id: "20263",
    name: "USC Fall 2026",
    firstDay: "2026-08-24",
    lastDay: "2026-12-04",
    holidays: [
      { date: "2026-09-07", name: "Labor Day" },
      { date: "2026-10-08", name: "Fall Recess" },
      { date: "2026-10-09", name: "Fall Recess" },
      { date: "2026-11-11", name: "Veterans Day" },
      { date: "2026-11-25", name: "Thanksgiving" },
      { date: "2026-11-26", name: "Thanksgiving" },
      { date: "2026-11-27", name: "Thanksgiving" },
      { date: "2026-11-28", name: "Thanksgiving" },
      { date: "2026-11-29", name: "Thanksgiving" },
    ],
  },
  sections: [
    // Normal MWF lecture, with a location — LOCATION is untested by Stage 1's scraper, but the
    // generator supports it, so exercise it here.
    {
      id: "30011R",
      course: "CSCI 201",
      title: "Principles of Software Development",
      type: "Lecture",
      instructor: "Prof. A. Rivera",
      meetings: [{ days: ["MO", "WE", "FR"], start: "10:00", end: "10:50", location: "SAL 101" }],
    },
    // TTh lecture. Fall 2026 firstDay is Mon Aug 24, so DTSTART must land on Tue Aug 25.
    {
      id: "30022R",
      course: "CSCI 104",
      title: "Foundations of Programming",
      type: "Lecture",
      instructor: "Prof. K. Chen",
      meetings: [{ days: ["TU", "TH"], start: "09:30", end: "10:50" }],
    },
    // Title with a comma and an ampersand — a real course title that hits escaping.
    {
      id: "30044R",
      course: "BUAD 304",
      title: "Leading Organizations, Teams & People",
      type: "Lecture",
      instructor: "Prof. M. Okafor",
      meetings: [{ days: ["MO", "WE"], start: "15:30", end: "16:50" }],
    },
    // Async discussion section — days: [] must be dropped, no VEVENT emitted.
    {
      id: "30044D",
      course: "BUAD 304",
      title: "Leading Organizations, Teams & People",
      type: "Discussion",
      instructor: "TBA",
      meetings: [{ days: [] }],
    },
  ],
};

// escapeText

test("escapeText: backslash, semicolon, comma, newline each escape individually", () => {
  assert.equal(escapeText("a\\b"), "a\\\\b");
  assert.equal(escapeText("a;b"), "a\\;b");
  assert.equal(escapeText("a,b"), "a\\,b");
  assert.equal(escapeText("a\nb"), "a\\nb");
});

test("escapeText: ampersand is left raw", () => {
  assert.equal(escapeText("Teams & People"), "Teams & People");
});

test("escapeText: backslash + semicolon + comma + newline together escape correctly and in order", () => {
  // backslash must be escaped first, or the backslashes introduced by the later rules
  // (\; \, \n) would themselves get doubled.
  const input = "back\\slash;semi,comma\nend";
  const expected = "back\\\\slash\\;semi\\,comma\\nend";
  assert.equal(escapeText(input), expected);
});

test("escapeText: CRLF, bare CR, and bare LF each normalize to an escaped newline", () => {
  assert.equal(escapeText("first\r\nsecond\rthird\nfourth"), "first\\nsecond\\nthird\\nfourth");
});

test("escapeText: real title with comma and ampersand escapes only the comma", () => {
  const input = "Leading Organizations, Teams & People";
  assert.equal(escapeText(input), "Leading Organizations\\, Teams & People");
});

// foldLine / unfoldLines

test("foldLine: a line at or under 75 octets is left unfolded", () => {
  const line = "SUMMARY:short line";
  assert.equal(foldLine(line), line);
});

test("foldLine: a long ASCII line folds into physical lines of <=75 octets each", () => {
  const line = "DESCRIPTION:" + "x".repeat(200);
  const folded = foldLine(line);
  for (const physical of folded.split(CRLF)) {
    assert.ok(octetLen(physical) <= 75, `physical line exceeds 75 octets: "${physical}"`);
  }
});

test("foldLine/unfoldLines: round-trips for a long ASCII line", () => {
  const line = "DESCRIPTION:" + "the quick brown fox jumps over the lazy dog ".repeat(5);
  assert.equal(unfoldLines(foldLine(line)), line);
});

test("foldLine: a multi-byte character positioned at the fold boundary is not split, and round-trips", () => {
  // "日" is a 3-byte UTF-8 character. 74 ASCII bytes + this character crosses the 75-octet
  // limit exactly inside the character's byte sequence, forcing the continuation-byte
  // back-off logic to actually engage.
  const line = "a".repeat(74) + "日" + "b".repeat(20);
  const folded = foldLine(line);

  for (const physical of folded.split(CRLF)) {
    assert.ok(octetLen(physical) <= 75, `physical line exceeds 75 octets: "${physical}"`);
    assert.ok(!physical.includes("�"), `physical line contains a corrupted character: "${physical}"`);
  }

  assert.equal(unfoldLines(folded), line);
});

test("foldLine: whitespace next to a UTF-8 fold boundary cannot move the split into a code point", () => {
  const line = "a".repeat(71) + "— " + "b".repeat(20);
  const folded = foldLine(line);

  for (const physical of folded.split(CRLF)) {
    assert.ok(octetLen(physical) <= 75, `physical line exceeds 75 octets: "${physical}"`);
    assert.ok(!physical.includes("�"), `physical line contains a corrupted character: "${physical}"`);
  }

  assert.equal(unfoldLines(folded), line);
});

// firstOccurrenceOnOrAfter

test("firstOccurrenceOnOrAfter: Fall 2026 (firstDay Mon Aug 24) TTh class starts Tue Aug 25", () => {
  assert.equal(firstOccurrenceOnOrAfter("2026-08-24", ["TU", "TH"]), "2026-08-25");
});

test("firstOccurrenceOnOrAfter: a day matching firstDay itself returns firstDay unchanged", () => {
  assert.equal(firstOccurrenceOnOrAfter("2026-08-24", ["MO", "WE", "FR"]), "2026-08-24");
});

// utcOffsetHours — DST acceptance table

const dstCases: [string, number][] = [
  ["2027-01-15", -8],
  ["2027-03-13", -8],
  ["2027-03-15", -7],
  ["2026-10-30", -7],
  ["2026-11-05", -8], // Nov 1 2026 is a Sunday, so DST ends Nov 1
  ["2026-11-10", -8],
];

for (const [date, expected] of dstCases) {
  test(`utcOffsetHours: ${date} = ${expected}`, () => {
    assert.equal(utcOffsetHours(date), expected);
  });
}

// generateICS — structural

const output = generateICS(fixtureSchedule, { generatedAt: GENERATED_AT });
const lines = physicalLines(output);

test("generateICS: has balanced BEGIN/END:VCALENDAR", () => {
  assert.ok(lines.includes("BEGIN:VCALENDAR"));
  assert.ok(lines.includes("END:VCALENDAR"));
});

test("generateICS: embeds a full VTIMEZONE block for America/Los_Angeles with DAYLIGHT and STANDARD subcomponents", () => {
  assert.ok(lines.includes("BEGIN:VTIMEZONE"));
  assert.ok(lines.includes("END:VTIMEZONE"));
  assert.ok(lines.includes("TZID:America/Los_Angeles"));
  assert.ok(lines.includes("BEGIN:DAYLIGHT"));
  assert.ok(lines.includes("END:DAYLIGHT"));
  assert.ok(lines.includes("BEGIN:STANDARD"));
  assert.ok(lines.includes("END:STANDARD"));
  assert.ok(lines.some((l) => l.startsWith("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU")));
  assert.ok(lines.some((l) => l.startsWith("RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU")));
  const vtimezoneIndex = lines.indexOf("BEGIN:VTIMEZONE");
  const firstVeventIndex = lines.indexOf("BEGIN:VEVENT");
  assert.ok(vtimezoneIndex > lines.indexOf("PRODID:-//usc-schedule-export//EN"));
  assert.ok(vtimezoneIndex < firstVeventIndex);
});

test("generateICS: uses CRLF throughout, never a bare LF", () => {
  const withoutCRLF = output.split(CRLF).join("");
  assert.ok(!withoutCRLF.includes("\n"), "found a line ending that is LF-only, not CRLF");
});

test("generateICS: VEVENTs are balanced", () => {
  const begins = lines.filter((l) => l === "BEGIN:VEVENT").length;
  const ends = lines.filter((l) => l === "END:VEVENT").length;
  assert.ok(begins > 0, "expected at least one VEVENT");
  assert.equal(begins, ends);
});

test("generateICS: every VEVENT has exactly one UTC DTSTAMP using the supplied generation time", () => {
  const eventBlocks = unfoldLines(output)
    .split("BEGIN:VEVENT" + CRLF)
    .slice(1);
  assert.ok(eventBlocks.length > 0, "expected at least one VEVENT");

  for (const event of eventBlocks) {
    const dtstamps = event.split(CRLF).filter((line) => line.startsWith("DTSTAMP:"));
    assert.deepEqual(dtstamps, ["DTSTAMP:20260801T123456Z"]);
  }
});

test("generateICS: rejects an invalid supplied generation time", () => {
  assert.throws(
    () => generateICS(fixtureSchedule, { generatedAt: new Date(Number.NaN) }),
    /generatedAt must be a valid Date/,
  );
});

test("generateICS: the async section (days: []) is dropped — no VEVENT references it", () => {
  assert.ok(!output.includes("30044D"));
});

test("countExportableMeetings: counts emitted meetings rather than registered sections", () => {
  assert.equal(countExportableMeetings(fixtureSchedule), 3);
  assert.equal(
    countExportableMeetings({
      term: fixtureSchedule.term,
      sections: [{ ...fixtureSchedule.sections[3]!, meetings: [{ days: [] }] }],
    }),
    0,
  );
});

test("generateICS: no physical line exceeds 75 octets", () => {
  for (const line of lines) {
    assert.ok(octetLen(line) <= 75, `line exceeds 75 octets: "${line}"`);
  }
});

test("generateICS: the whole output round-trips through unfold(fold(x))", () => {
  const unfolded = unfoldLines(output);
  const unfoldedLines = physicalLines(unfolded);
  assert.ok(unfoldedLines.includes("BEGIN:VCALENDAR"));
  assert.ok(unfoldedLines.includes("END:VCALENDAR"));
  const refolded = unfoldedLines.map(foldLine).join(CRLF) + CRLF;
  assert.equal(refolded, output);
});

// generateICS — correctness (non-DST/holiday subset)

const unfolded = unfoldLines(output);

test("generateICS: comma is escaped and ampersand stays raw in the BUAD 304 title", () => {
  assert.ok(unfolded.includes("Leading Organizations\\, Teams & People"));
  assert.ok(!unfolded.includes("Leading Organizations, Teams & People"));
});

test("generateICS: the TTh class's DTSTART carries TZID and is Tue Aug 25 2026 at 09:30 local", () => {
  assert.ok(unfolded.includes("DTSTART;TZID=America/Los_Angeles:20260825T093000"));
});

// VTIMEZONE's own DAYLIGHT/STANDARD subcomponents legitimately carry a bare (no-TZID) DTSTART
// and a YEARLY RRULE with no UNTIL — that's the timezone *rule definition*, not event data, so
// the next tests scope to the VEVENT region only (after VTIMEZONE ends).
const veventRegion = unfolded.slice(unfolded.indexOf("END:VTIMEZONE"));

test("generateICS: DTSTART/DTEND never appear without a TZID param on any VEVENT — no floating times remain", () => {
  const dtLines = veventRegion.split(CRLF).filter((l) => l.startsWith("DTSTART:") || l.startsWith("DTEND:"));
  assert.deepEqual(dtLines, [], `found floating (no-TZID) date-time line(s): ${dtLines.join(", ")}`);
});

test("generateICS: UNTIL is Z-suffixed and offset-correct for fall 2026's lastDay — Dec 4 2026 23:59:59 PST -> 20261205T075959Z", () => {
  const rruleLines = veventRegion.split(CRLF).filter((l) => l.startsWith("RRULE:FREQ=WEEKLY"));
  assert.ok(rruleLines.length > 0);
  for (const line of rruleLines) {
    assert.match(line, /UNTIL=20261205T075959Z(;|$)/, `unexpected UNTIL in: ${line}`);
  }
});

test("generateICS: LOCATION is emitted only when a meeting has one", () => {
  assert.ok(unfolded.includes("LOCATION:SAL 101"));
  const tthEvent = unfolded.split(CRLF + "BEGIN:VEVENT").find((block) => block.includes("UID:20263-30022R-0"));
  assert.ok(tthEvent, "expected to find the TTh class's VEVENT block");
  assert.ok(!tthEvent.includes("LOCATION:"));
});

test("generateICS: EXDATE carries the same TZID as DTSTART", () => {
  const exdateLines = unfolded.split(CRLF).filter((l) => l.startsWith("EXDATE"));
  assert.ok(exdateLines.length > 0, "expected at least one EXDATE line");
  for (const line of exdateLines) {
    assert.match(line, /^EXDATE;TZID=America\/Los_Angeles:/);
  }
});

// Locked worked example (confirmed against the actual weekdays of the Fall 2026 dates:
// Sep 7 = Mon, Oct 8-9 = Thu-Fri, Nov 11 = Wed, Nov 25-29 = Wed-Sun).

const mwfEvent = unfolded.split(CRLF + "BEGIN:VEVENT").find((block) => block.includes("UID:20263-30011R-0"));
const tthEvent = unfolded.split(CRLF + "BEGIN:VEVENT").find((block) => block.includes("UID:20263-30022R-0"));

test("generateICS: MWF class excludes Sep 7, Oct 9, Nov 11, Nov 25, and Nov 27 — five dates", () => {
  assert.ok(mwfEvent, "expected to find the MWF class's VEVENT block");
  const exdateLine = mwfEvent!.split(CRLF).find((l) => l.startsWith("EXDATE"));
  assert.ok(exdateLine, "expected an EXDATE line on the MWF class");
  for (const digits of ["20260907", "20261009", "20261111", "20261125", "20261127"]) {
    assert.ok(exdateLine!.includes(digits), `expected EXDATE to include ${digits}: ${exdateLine}`);
  }
});

test("generateICS: MWF class does NOT exclude Oct 8 or Nov 26 — both Thursdays, never an MWF meeting day", () => {
  const exdateLine = mwfEvent!.split(CRLF).find((l) => l.startsWith("EXDATE"));
  for (const digits of ["20261008", "20261126"]) {
    assert.ok(!exdateLine!.includes(digits), `did not expect EXDATE to include ${digits}: ${exdateLine}`);
  }
});

test("generateICS: TTh class excludes only Oct 8 and Nov 26 — two dates", () => {
  assert.ok(tthEvent, "expected to find the TTh class's VEVENT block");
  const exdateLine = tthEvent!.split(CRLF).find((l) => l.startsWith("EXDATE"));
  assert.ok(exdateLine, "expected an EXDATE line on the TTh class");
  for (const digits of ["20261008", "20261126"]) {
    assert.ok(exdateLine!.includes(digits), `expected EXDATE to include ${digits}: ${exdateLine}`);
  }
});

test("generateICS: TTh class does NOT exclude Sep 7, Oct 9, Nov 11, Nov 25, or Nov 27 — none are Tue/Thu", () => {
  const exdateLine = tthEvent!.split(CRLF).find((l) => l.startsWith("EXDATE"));
  for (const digits of ["20260907", "20261009", "20261111", "20261125", "20261127"]) {
    assert.ok(!exdateLine!.includes(digits), `did not expect EXDATE to include ${digits}: ${exdateLine}`);
  }
});

test("generateICS: each section uses its live session boundaries and merges session breaks with term holidays", () => {
  const sessionOutput = unfoldLines(
    generateICS(
      {
        term: fixtureSchedule.term,
        sections: [
          {
            id: "14470",
            session: {
              id: "928",
              firstDay: "2026-09-14",
              lastDay: "2026-10-26",
              holidays: [{ date: "2026-10-12", name: "Session break" }],
            },
            course: "BUAD 100",
            title: "The Business Experience",
            type: "Lecture",
            instructor: "Prof. T. Trojan",
            meetings: [{ days: ["MO", "TH"], start: "08:00", end: "09:50" }],
          },
        ],
      },
      { generatedAt: GENERATED_AT },
    ),
  );

  assert.ok(sessionOutput.includes("DTSTART;TZID=America/Los_Angeles:20260914T080000"));
  assert.ok(sessionOutput.includes("UNTIL=20261027T065959Z"));
  assert.ok(sessionOutput.includes("EXDATE;TZID=America/Los_Angeles:20261008T080000,20261012T080000"));
  assert.ok(!sessionOutput.includes("20260907T080000"), "term holiday before the session must be clipped");
  assert.ok(!sessionOutput.includes("20261126T080000"), "term holiday after the session must be clipped");
});

test("generateICS: rejects a meeting pattern with no occurrence inside its short session", () => {
  assert.throws(
    () =>
      generateICS({
        term: fixtureSchedule.term,
        sections: [
          {
            id: "15535",
            session: { id: "701", firstDay: "2026-08-03", lastDay: "2026-08-03" },
            course: "GSBA 501",
            title: "The Role of the Manager",
            type: "Lecture",
            instructor: "Prof. T. Trojan",
            meetings: [{ days: ["TU"], start: "08:00", end: "17:00" }],
          },
        ],
      }),
    /no meeting day within session 701/,
  );
});

test("generateICS: supports a valid special session wholly before the main semester", () => {
  const specialSessionOutput = unfoldLines(
    generateICS(
      {
        term: fixtureSchedule.term,
        sections: [
          {
            id: "15535",
            session: { id: "701", firstDay: "2026-08-03", lastDay: "2026-08-13" },
            course: "GSBA 501",
            title: "The Role of the Manager",
            type: "Lecture",
            instructor: "Prof. T. Trojan",
            meetings: [{ days: ["MO", "TU", "WE", "TH", "FR"], start: "08:00", end: "17:00" }],
          },
        ],
      },
      { generatedAt: GENERATED_AT },
    ),
  );

  assert.ok(specialSessionOutput.includes("DTSTART;TZID=America/Los_Angeles:20260803T080000"));
  assert.ok(specialSessionOutput.includes("UNTIL=20260814T065959Z"));
});

test("generateICS: UIDs are stable when the generation timestamp changes", () => {
  const output2 = generateICS(fixtureSchedule, { generatedAt: new Date("2026-08-02T23:45:01Z") });
  const uidLines = physicalLines(unfolded).filter((line) => line.startsWith("UID:"));
  const uidLines2 = physicalLines(unfoldLines(output2)).filter((line) => line.startsWith("UID:"));

  assert.deepEqual(uidLines2, uidLines);
  assert.notEqual(output2, output);
});

test("generateICS: UIDs use a domain controlled by the project", () => {
  const uidLines = physicalLines(unfolded).filter((line) => line.startsWith("UID:"));
  assert.ok(uidLines.length > 0);
  for (const line of uidLines) {
    assert.match(line, /@usc\.jonlu\.ca$/);
  }
});

test("generateICS: UIDs are unique within a single output", () => {
  const uidLines = physicalLines(unfolded).filter((l) => l.startsWith("UID:"));
  const uids = uidLines.map((l) => l.slice("UID:".length));
  assert.equal(new Set(uids).size, uids.length, "duplicate UID found");
});
