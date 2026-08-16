import assert from "node:assert/strict";
import test from "node:test";
import { parseScheduleDocument } from "@/extension/scheduleDocument";

const calendarDocument = (status: string) => {
  const payload = {
    data: {
      Data: [
        {
          Title: "CSCI 104",
          Start: "2026-08-24T10:00:00",
          End: "2026-08-24T11:50:00",
          Status: status,
        },
      ],
    },
  };
  return `<script>kendo.syncReady(${JSON.stringify(payload)}${String.fromCharCode(10)}`;
};

for (const status of ["Registered", "Scheduled", "Conflicted", "Blocked"]) {
  test(`parses USC calendar entries with ${status} status`, () => {
    assert.deepEqual(parseScheduleDocument(calendarDocument(status)), {
      Data: [
        {
          Title: "CSCI 104",
          Start: "2026-08-24T10:00:00",
          End: "2026-08-24T11:50:00",
        },
      ],
    });
  });
}

test("rejects calendar entries without the fields conflict detection consumes", () => {
  const payload = {
    data: {
      Data: [{ Title: "CSCI 104", Start: "2026-08-24T10:00:00" }],
    },
  };
  const document = `<script>kendo.syncReady(${JSON.stringify(payload)}${String.fromCharCode(10)}`;

  assert.equal(parseScheduleDocument(document), null);
});
