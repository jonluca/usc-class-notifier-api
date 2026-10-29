import assert from "node:assert/strict";
import test from "node:test";
import { resolveNotificationPhone } from "./notificationPhone";

test("notification phones prefer a valid section override, then account, then saved profile number", () => {
  const choices = {
    sectionPhone: "(213) 555-0100",
    accountPhone: "+12135550101",
    savedPhone: "+12135550102",
  };
  assert.equal(resolveNotificationPhone(choices), "+12135550100");
  assert.equal(resolveNotificationPhone({ ...choices, sectionPhone: null }), "+12135550101");
  assert.equal(resolveNotificationPhone({ ...choices, sectionPhone: "invalid", accountPhone: "" }), "+12135550102");
  assert.equal(resolveNotificationPhone({ savedPhone: "+44 20 7946 0958" }), "+442079460958");
  assert.equal(resolveNotificationPhone({}), null);
  assert.equal(resolveNotificationPhone({ sectionPhone: "2135550100 ext 1", savedPhone: "bad" }), null);
});
