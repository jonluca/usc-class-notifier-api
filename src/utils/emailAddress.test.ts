import assert from "node:assert/strict";
import test from "node:test";
import { emailAddressSchema, normalizeEmailAddress } from "./emailAddress";

test("corrects the USC and Gmail domains found in delivery failures", () => {
  for (const domain of ["usc.du", "usc.ed", "usc.efu", "usc.com"]) {
    assert.equal(emailAddressSchema.parse(`student@${domain}`), "student@usc.edu");
  }
  for (const domain of ["gmal.com", "gamil.com"]) {
    assert.equal(emailAddressSchema.parse(`student@${domain}`), "student@gmail.com");
  }
});

test("cleans pasted whitespace and case-insensitive typos while preserving valid account spellings", () => {
  const cases = [
    [" \tStudent.Name+classes @ USC.EDU \n", "Student.Name+classes@USC.EDU"],
    ["\u00a0Student.Name+classes@ GAMIL.COM\u00a0", "Student.Name+classes@gmail.com"],
    ["Student.Name+classes@GMAIL.COM", "Student.Name+classes@GMAIL.COM"],
    [" student@uscedu ", "student@usc.edu"],
    ["student@gmailcom", "student@gmail.com"],
    ["student@gmail.con", "student@gmail.com"],
    ["student@usc.eud", "student@usc.edu"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(emailAddressSchema.parse(input), expected);
    assert.equal(normalizeEmailAddress(expected!), expected);
  }
});

test("accepts other providers and similar real domains without guessing", () => {
  for (const domain of [
    "icloud.com",
    "qq.com",
    "outlook.com",
    "jonlu.ca",
    "uc.edu",
    "ucsd.edu",
    "ucla.edu",
    "mail.usc.edu",
    "gmail.com.example.com",
  ]) {
    const email = `Student.Name+classes@${domain}`;
    assert.equal(emailAddressSchema.parse(email), email);
  }
});

test("rejects malformed or ambiguous addresses instead of inventing a recipient", () => {
  for (const input of [
    "",
    " \n ",
    "student",
    "student.gmail.com",
    "@gmail.com",
    "student@",
    "student@@gmail.com",
    "student@usc.edu@gmail.com",
    "first last@gmail.com",
    "first..last@gmail.com",
    ".student@gmail.com",
    "student.@gmail.com",
    "student@g mail.com",
    "student@usc .edu",
    "Student <student@gmail.com>",
    "student@gmail.com,other@usc.edu",
    "student@gmail.com\nother@usc.edu",
    "student@gmail.com\r\nBcc:other@usc.edu",
    "student\u200b@gmail.com",
    "student@gmail.com;",
    `${"a".repeat(65)}@gmail.com`,
    `student@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(55)}.com`,
  ]) {
    assert.equal(emailAddressSchema.safeParse(input).success, false, input);
  }
  for (const input of [null, undefined, 123, ["student@gmail.com"]]) {
    assert.equal(emailAddressSchema.safeParse(input).success, false);
  }
});

test("accepts long valid addresses beyond the extension's former 35-character limit", () => {
  const email = `${"a".repeat(64)}@gmail.com`;
  assert.equal(emailAddressSchema.parse(email), email);
});
