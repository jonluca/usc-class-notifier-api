import assert from "node:assert/strict";
import test from "node:test";
import { simpleParser } from "mailparser";
import {
  BACKFILL_APPLY_CONFIRMATION,
  buildBackfillPlan,
  buildReceiptDeduplicationKey,
  calculateTargetFingerprint,
  classifyReceipt,
  classifyVenmoAuthentication,
  isSpecialUseMailboxCoverageComplete,
  parseBackfillArgs,
  parseReceiptBodyPaidIds,
} from "./backfillReconciliation.ts";
import type {
  ReceiptClassification,
  SpecialUseMailboxCoverage,
  SpecialUseMailboxCoverageEntry,
  WatchedSectionPaymentRow,
} from "./backfillReconciliation.ts";

const googleAuthPass =
  "Authentication-Results: mx.google.com; dkim=pass header.i=@venmo.com; dmarc=pass header.from=venmo.com";

const genuineReceipt = ({
  key,
  paidIds,
  internalDate,
}: {
  key: string;
  paidIds: string[];
  internalDate: Date | null;
}): ReceiptClassification => ({
  receiptKey: key,
  internalDate,
  authenticationStatus: "pass",
  status: paidIds.length === 0 ? "genuine_no_id" : paidIds.length === 1 ? "genuine_single_id" : "genuine_multiple_ids",
  plaintextPaidIds: paidIds,
  htmlPaidIds: paidIds,
  paidIds,
  representationsDisagree: false,
  htmlConversionFailed: false,
});

const row = (overrides: Partial<WatchedSectionPaymentRow> & Pick<WatchedSectionPaymentRow, "id" | "paidId">) => ({
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  isPaid: false,
  paidNotified: false,
  ...overrides,
});

const completeMailboxCoverage = (
  overrides: Partial<SpecialUseMailboxCoverageEntry> = {},
): SpecialUseMailboxCoverageEntry => ({
  present: true,
  scanned: true,
  openedReadOnly: true,
  highWaterUidBounded: true,
  complete: true,
  searchMatchedMessageCount: 2,
  fetchedMessageCount: 2,
  deduplicatedMessageCount: 0,
  incompleteMessageCount: 0,
  scanErrorCount: 0,
  ...overrides,
});

test("dry-run is the default and apply requires an exact confirmation", () => {
  assert.deepEqual(parseBackfillArgs([]), {
    apply: false,
    chunkSize: 50,
    clockSkewMs: 300_000,
    expectedTargetCount: null,
    expectedTargetSha256: null,
    help: false,
    maxMessageBytes: 5_242_880,
  });
  assert.throws(() => parseBackfillArgs(["--apply"]), /requires --confirm/);
  assert.throws(() => parseBackfillArgs(["--confirm=wrong"]), /only valid with --apply/);
  assert.throws(
    () => parseBackfillArgs(["--apply", `--confirm=${BACKFILL_APPLY_CONFIRMATION}`, "--expected-target-count=2"]),
    /requires --expected-target-sha256/,
  );

  const options = parseBackfillArgs([
    "--apply",
    `--confirm=${BACKFILL_APPLY_CONFIRMATION}`,
    "--expected-target-count=2",
    `--expected-target-sha256=${"a".repeat(64)}`,
    "--chunk-size=25",
    "--clock-skew-seconds=120",
    "--max-message-bytes=1048576",
  ]);
  assert.deepEqual(options, {
    apply: true,
    chunkSize: 25,
    clockSkewMs: 120_000,
    expectedTargetCount: 2,
    expectedTargetSha256: "a".repeat(64),
    help: false,
    maxMessageBytes: 1_048_576,
  });
});

test("rejects unsafe CLI bounds and unknown arguments", () => {
  assert.throws(() => parseBackfillArgs(["--chunk-size=0"]), /between 1 and 250/);
  assert.throws(() => parseBackfillArgs(["--clock-skew-seconds=901"]), /between 0 and 900/);
  assert.throws(() => parseBackfillArgs(["--max-message-bytes=12"]), /between 65536/);
  assert.throws(() => parseBackfillArgs(["--unexpected"]), /Unknown argument/);
  assert.throws(() => parseBackfillArgs([`--expected-target-sha256=${"a".repeat(64)}`]), /only valid with --apply/);
  assert.throws(
    () =>
      parseBackfillArgs([
        "--apply",
        `--confirm=${BACKFILL_APPLY_CONFIRMATION}`,
        "--expected-target-count=1",
        "--expected-target-sha256=not-a-digest",
      ]),
    /64-character hexadecimal/,
  );
});

test("target fingerprint is deterministic and changes with any guarded target field", () => {
  const first = {
    rowId: "row-b",
    paidId: "12345678",
    receiptCutoff: new Date("2026-01-02T00:05:00.000Z"),
  };
  const second = {
    rowId: "row-a",
    paidId: "87654321",
    receiptCutoff: new Date("2026-01-03T00:05:00.000Z"),
  };
  const fingerprint = calculateTargetFingerprint([first, second]);

  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, calculateTargetFingerprint([second, first]));
  assert.notEqual(
    fingerprint,
    calculateTargetFingerprint([{ ...first, receiptCutoff: new Date("2026-01-02T00:05:00.001Z") }, second]),
  );
});

test("deduplication identity prioritizes Gmail email ID, then Message-ID, then mailbox UID", () => {
  const gmailIdentity = buildReceiptDeduplicationKey({
    emailId: "ABC123",
    messageId: "<first@example.com>",
    mailboxUidKey: "all:1:10",
  });
  assert.equal(
    gmailIdentity,
    buildReceiptDeduplicationKey({
      emailId: "abc123",
      messageId: "<different@example.com>",
      mailboxUidKey: "trash:2:20",
    }),
  );
  assert.notEqual(
    gmailIdentity,
    buildReceiptDeduplicationKey({
      emailId: "different-email-id",
      messageId: "<first@example.com>",
      mailboxUidKey: "all:1:10",
    }),
  );

  const messageIdentity = buildReceiptDeduplicationKey({
    messageId: " <receipt-1@venmo.com> ",
    mailboxUidKey: "all:1:10",
  });
  assert.equal(
    messageIdentity,
    buildReceiptDeduplicationKey({
      messageId: "<receipt-1@venmo.com>",
      mailboxUidKey: "junk:9:99",
    }),
  );
  assert.match(messageIdentity, /^message-id:[a-f0-9]{64}$/);

  assert.notEqual(
    buildReceiptDeduplicationKey({ mailboxUidKey: "all:1:10" }),
    buildReceiptDeduplicationKey({ mailboxUidKey: "trash:1:10" }),
  );
});

test("coverage requires All Mail and every present special-use mailbox to complete", () => {
  const absentOptionalMailbox = completeMailboxCoverage({
    present: false,
    scanned: false,
    openedReadOnly: false,
    highWaterUidBounded: false,
    complete: false,
    searchMatchedMessageCount: 0,
    fetchedMessageCount: 0,
  });
  const coverage: SpecialUseMailboxCoverage = {
    allMail: completeMailboxCoverage(),
    junk: absentOptionalMailbox,
    trash: absentOptionalMailbox,
  };

  assert.equal(isSpecialUseMailboxCoverageComplete(coverage), true);
  assert.equal(
    isSpecialUseMailboxCoverageComplete({
      ...coverage,
      allMail: completeMailboxCoverage({ present: false }),
    }),
    false,
  );
  assert.equal(
    isSpecialUseMailboxCoverageComplete({
      ...coverage,
      junk: completeMailboxCoverage({ complete: false, incompleteMessageCount: 1 }),
    }),
    false,
  );
  assert.equal(
    isSpecialUseMailboxCoverageComplete({
      ...coverage,
      trash: completeMailboxCoverage({ openedReadOnly: false }),
    }),
    false,
  );
  assert.equal(
    isSpecialUseMailboxCoverageComplete({
      ...coverage,
      junk: completeMailboxCoverage({ scanErrorCount: 1 }),
    }),
    false,
  );
});

test("trusts only a Gmail authentication result that passes for venmo.com", () => {
  assert.equal(classifyVenmoAuthentication([googleAuthPass]), "pass");
  assert.equal(
    classifyVenmoAuthentication([
      "Authentication-Results: attacker.example; dkim=pass header.i=@venmo.com; dmarc=pass header.from=venmo.com",
    ]),
    "unknown",
  );
  assert.equal(
    classifyVenmoAuthentication([
      "Authentication-Results: mx.google.com; dkim=fail header.i=@venmo.com; dmarc=fail header.from=venmo.com",
    ]),
    "fail",
  );
  assert.equal(
    classifyVenmoAuthentication([
      "Authentication-Results: mx.google.com; dkim=fail header.i=@venmo.com; dmarc=fail header.from=venmo.com",
      googleAuthPass,
    ]),
    "fail",
  );
  assert.equal(
    classifyVenmoAuthentication(["Authentication-Results: mx.google.com; dkim=pass header.i=@venmo.com.evil.example"]),
    "unknown",
  );
});

test("parses plaintext and HTML independently and unions their paid IDs", () => {
  const parsed = parseReceiptBodyPaidIds({
    plaintext: "Transaction ID\n12345678\nView this payment in Venmo",
    html: "<p>Payment note</p><p>40449471</p>",
  });

  assert.deepEqual(parsed.plaintextPaidIds, []);
  assert.deepEqual(parsed.htmlPaidIds, ["40449471"]);
  assert.deepEqual(parsed.paidIds, ["40449471"]);
  assert.equal(parsed.representationsDisagree, true);
  assert.equal(parsed.htmlConversionFailed, false);
});

test("classifies a synthetic authenticated multipart receipt using the HTML-only ID", async () => {
  const raw = [
    "From: Venmo <venmo@venmo.com>",
    "Subject: Alex paid you $1.00",
    googleAuthPass,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="fixture"',
    "",
    "--fixture",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "View this payment in Venmo.",
    "--fixture",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Payment note</p><p>40449471</p>",
    "--fixture--",
    "",
  ].join("\r\n");
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true });
  const classification = classifyReceipt({
    receiptKey: "fixture",
    internalDate: new Date("2026-01-02T00:00:00.000Z"),
    subject: parsed.subject ?? "",
    fromAddresses: parsed.from?.value.flatMap((entry) => (entry.address ? [entry.address] : [])) ?? [],
    authenticationHeaders: parsed.headerLines
      .filter((header) => header.key.toLowerCase() === "authentication-results")
      .map((header) => header.line),
    plaintext: parsed.text,
    html: parsed.html === false ? undefined : parsed.html,
  });

  assert.equal(classification.status, "genuine_single_id");
  assert.deepEqual(classification.plaintextPaidIds, []);
  assert.deepEqual(classification.htmlPaidIds, ["40449471"]);
});

test("rejects wrong senders, wrong amounts, and unauthenticated candidates", () => {
  const common = {
    receiptKey: "fixture",
    internalDate: new Date("2026-01-02T00:00:00.000Z"),
    authenticationHeaders: [googleAuthPass],
    plaintext: "Note: 12345678",
  };

  assert.equal(
    classifyReceipt({ ...common, subject: "Alex paid you $1.00", fromAddresses: ["attacker@example.com"] }).status,
    "rejected_sender",
  );
  assert.equal(
    classifyReceipt({ ...common, subject: "Alex paid you $2.00", fromAddresses: ["venmo@venmo.com"] }).status,
    "rejected_subject",
  );
  assert.equal(
    classifyReceipt({
      ...common,
      subject: "Alex paid you $1.00",
      fromAddresses: ["venmo@venmo.com"],
      authenticationHeaders: [],
    }).status,
    "authentication_unknown",
  );
});

test("builds a privacy-safe plan for only unambiguous, date-eligible rows", () => {
  const receiptDate = new Date("2026-01-02T00:00:00.000Z");
  const receipts = [
    genuineReceipt({ key: "eligible-1", paidIds: ["11111111"], internalDate: receiptDate }),
    genuineReceipt({ key: "eligible-duplicate", paidIds: ["11111111"], internalDate: receiptDate }),
    genuineReceipt({ key: "already-complete", paidIds: ["22222222"], internalDate: receiptDate }),
    genuineReceipt({ key: "already-pending", paidIds: ["33333333"], internalDate: receiptDate }),
    genuineReceipt({ key: "unmatched", paidIds: ["44444444"], internalDate: receiptDate }),
    genuineReceipt({ key: "ambiguous", paidIds: ["55555555", "66666666"], internalDate: receiptDate }),
    genuineReceipt({ key: "duplicate-db", paidIds: ["77777777"], internalDate: receiptDate }),
    genuineReceipt({ key: "no-date", paidIds: ["88888888"], internalDate: null }),
    genuineReceipt({ key: "too-new", paidIds: ["99999999"], internalDate: receiptDate }),
    genuineReceipt({ key: "at-cutoff", paidIds: ["12121212"], internalDate: receiptDate }),
    genuineReceipt({ key: "inconsistent", paidIds: ["13131313"], internalDate: receiptDate }),
    genuineReceipt({ key: "missing-created", paidIds: ["14141414"], internalDate: receiptDate }),
  ];
  const rows = [
    row({ id: "row-eligible", paidId: "11111111" }),
    row({ id: "row-complete", paidId: "22222222", isPaid: true, paidNotified: true }),
    row({ id: "row-pending", paidId: "33333333", isPaid: true }),
    row({ id: "row-ambiguous-a", paidId: "55555555" }),
    row({ id: "row-ambiguous-b", paidId: "66666666" }),
    row({ id: "row-duplicate-a", paidId: "77777777" }),
    row({ id: "row-duplicate-b", paidId: "77777777" }),
    row({ id: "row-no-date", paidId: "88888888" }),
    row({ id: "row-too-new", paidId: "99999999", createdAt: new Date("2026-01-02T00:05:00.001Z") }),
    row({ id: "row-at-cutoff", paidId: "12121212", createdAt: new Date("2026-01-02T00:05:00.000Z") }),
    row({ id: "row-inconsistent", paidId: "13131313", paidNotified: true }),
    row({ id: "row-no-created", paidId: "14141414", createdAt: null }),
  ];

  const plan = buildBackfillPlan(receipts, rows, 5 * 60 * 1000);

  assert.deepEqual(
    plan.applyCandidates.map(({ rowId }) => rowId),
    ["row-at-cutoff", "row-eligible"],
  );
  assert.deepEqual(plan.stats, {
    uniquePaidIdCount: 12,
    paidIdsSeenInMultipleReceiptsCount: 1,
    paidIdsFromAmbiguousReceiptsCount: 2,
    unmatchedPaidIdCount: 1,
    paidIdsWithMultipleDbRowsCount: 1,
    alreadyPaidDbRowCount: 2,
    alreadyPaidPendingNotificationRowCount: 1,
    inconsistentUnpaidButNotifiedRowCount: 1,
    unpaidRowMissingCreatedAtCount: 1,
    paidIdWithoutUsableReceiptDateCount: 1,
    unpaidRowCreatedAfterReceiptCount: 1,
    eligibleRowCount: 2,
  });
});

test("uses the earliest duplicate receipt date for the creation-time guard", () => {
  const receipts = [
    genuineReceipt({
      key: "first",
      paidIds: ["15151515"],
      internalDate: new Date("2026-01-02T00:00:00.000Z"),
    }),
    genuineReceipt({
      key: "later",
      paidIds: ["15151515"],
      internalDate: new Date("2026-01-02T01:00:00.000Z"),
    }),
  ];
  const rows = [
    row({ id: "created-between-receipts", paidId: "15151515", createdAt: new Date("2026-01-02T00:30:00.000Z") }),
  ];

  const plan = buildBackfillPlan(receipts, rows, 5 * 60 * 1000);
  assert.equal(plan.applyCandidates.length, 0);
  assert.equal(plan.stats.unpaidRowCreatedAfterReceiptCount, 1);
});
