import { createHash } from "node:crypto";
import { convert } from "html-to-text";
import { isExpectedVenmoPaymentSubject, parseVenmoPaidIds } from "./venmoEmail.ts";

export const VENMO_SENDER = "venmo@venmo.com";
export const DEFAULT_RECEIPT_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const BACKFILL_APPLY_CONFIRMATION = "MARK_MATCHED_VENMO_RECEIPTS_PAID";
export const DEFAULT_SCAN_CHUNK_SIZE = 50;
export const DEFAULT_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

export interface BackfillCliOptions {
  apply: boolean;
  chunkSize: number;
  clockSkewMs: number;
  expectedTargetCount: number | null;
  expectedTargetSha256: string | null;
  help: boolean;
  maxMessageBytes: number;
}

export type VenmoAuthenticationStatus = "pass" | "fail" | "unknown";

export type ReceiptClassificationStatus =
  | "rejected_sender"
  | "rejected_subject"
  | "authentication_failed"
  | "authentication_unknown"
  | "genuine_no_id"
  | "genuine_single_id"
  | "genuine_multiple_ids";

export interface ReceiptBodyIds {
  plaintextPaidIds: string[];
  htmlPaidIds: string[];
  paidIds: string[];
  representationsDisagree: boolean;
  htmlConversionFailed: boolean;
}

export interface ReceiptClassification extends ReceiptBodyIds {
  receiptKey: string;
  internalDate: Date | null;
  authenticationStatus: VenmoAuthenticationStatus;
  status: ReceiptClassificationStatus;
}

export interface ReceiptClassificationInput {
  receiptKey: string;
  internalDate: Date | null;
  subject: string;
  fromAddresses: string[];
  authenticationHeaders: string[];
  plaintext?: string;
  html?: string;
}

export interface WatchedSectionPaymentRow {
  id: string;
  paidId: string;
  createdAt: Date | null;
  isPaid: boolean;
  paidNotified: boolean;
}

export interface BackfillApplyCandidate {
  rowId: string;
  paidId: string;
  receiptCutoff: Date;
}

export interface BackfillPlanStats {
  uniquePaidIdCount: number;
  paidIdsSeenInMultipleReceiptsCount: number;
  paidIdsFromAmbiguousReceiptsCount: number;
  unmatchedPaidIdCount: number;
  paidIdsWithMultipleDbRowsCount: number;
  alreadyPaidDbRowCount: number;
  alreadyPaidPendingNotificationRowCount: number;
  inconsistentUnpaidButNotifiedRowCount: number;
  unpaidRowMissingCreatedAtCount: number;
  paidIdWithoutUsableReceiptDateCount: number;
  unpaidRowCreatedAfterReceiptCount: number;
  eligibleRowCount: number;
}

export interface BackfillPlan {
  applyCandidates: BackfillApplyCandidate[];
  stats: BackfillPlanStats;
}

export interface ReceiptDeduplicationIdentity {
  emailId?: string;
  messageId?: string;
  mailboxUidKey: string;
}

export interface SpecialUseMailboxCoverageEntry {
  present: boolean;
  scanned: boolean;
  openedReadOnly: boolean;
  highWaterUidBounded: boolean;
  complete: boolean;
  searchMatchedMessageCount: number;
  fetchedMessageCount: number;
  deduplicatedMessageCount: number;
  incompleteMessageCount: number;
  scanErrorCount: number;
}

export interface SpecialUseMailboxCoverage {
  allMail: SpecialUseMailboxCoverageEntry;
  junk: SpecialUseMailboxCoverageEntry;
  trash: SpecialUseMailboxCoverageEntry;
}

const parseBoundedInteger = ({
  name,
  value,
  min,
  max,
}: {
  name: string;
  value: string;
  min: number;
  max: number;
}): number => {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
};

export const parseBackfillArgs = (args: string[]): BackfillCliOptions => {
  let apply = false;
  let confirmation: string | undefined;
  let chunkSize = DEFAULT_SCAN_CHUNK_SIZE;
  let clockSkewMs = DEFAULT_RECEIPT_CLOCK_SKEW_MS;
  let expectedTargetCount: number | null = null;
  let expectedTargetSha256: string | null = null;
  let help = false;
  let maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES;

  for (const arg of args) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--help") {
      help = true;
    } else if (arg.startsWith("--confirm=")) {
      confirmation = arg.slice("--confirm=".length);
    } else if (arg.startsWith("--expected-target-count=")) {
      expectedTargetCount = parseBoundedInteger({
        name: "expected-target-count",
        value: arg.slice("--expected-target-count=".length),
        min: 0,
        max: 1_000_000,
      });
    } else if (arg.startsWith("--expected-target-sha256=")) {
      const fingerprint = arg.slice("--expected-target-sha256=".length).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
        throw new Error("expected-target-sha256 must be a 64-character hexadecimal SHA-256 digest");
      }
      expectedTargetSha256 = fingerprint;
    } else if (arg.startsWith("--chunk-size=")) {
      chunkSize = parseBoundedInteger({
        name: "chunk-size",
        value: arg.slice("--chunk-size=".length),
        min: 1,
        max: 250,
      });
    } else if (arg.startsWith("--max-message-bytes=")) {
      maxMessageBytes = parseBoundedInteger({
        name: "max-message-bytes",
        value: arg.slice("--max-message-bytes=".length),
        min: 64 * 1024,
        max: 10 * 1024 * 1024,
      });
    } else if (arg.startsWith("--clock-skew-seconds=")) {
      const seconds = parseBoundedInteger({
        name: "clock-skew-seconds",
        value: arg.slice("--clock-skew-seconds=".length),
        min: 0,
        max: 15 * 60,
      });
      clockSkewMs = seconds * 1000;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (confirmation && !apply) {
    throw new Error("--confirm is only valid with --apply");
  }
  if (!apply && (expectedTargetCount !== null || expectedTargetSha256 !== null)) {
    throw new Error("expected target arguments are only valid with --apply");
  }
  if (apply && confirmation !== BACKFILL_APPLY_CONFIRMATION) {
    throw new Error(`--apply requires --confirm=${BACKFILL_APPLY_CONFIRMATION}`);
  }
  if (apply && expectedTargetCount === null) {
    throw new Error("--apply requires --expected-target-count from a preceding dry run");
  }
  if (apply && expectedTargetSha256 === null) {
    throw new Error("--apply requires --expected-target-sha256 from a preceding dry run");
  }

  return {
    apply,
    chunkSize,
    clockSkewMs,
    expectedTargetCount,
    expectedTargetSha256,
    help,
    maxMessageBytes,
  };
};

/**
 * The dry-run/apply handshake hashes a versioned, deterministic encoding of
 * every target row, paid ID, and receipt cutoff. Only the digest is reported.
 */
export const calculateTargetFingerprint = (candidates: BackfillApplyCandidate[]): string => {
  const canonicalTargets = candidates
    .map((candidate) => JSON.stringify([candidate.rowId, candidate.paidId, candidate.receiptCutoff.toISOString()]))
    .sort();
  const canonicalPayload = ["venmo-backfill-targets-v1", ...canonicalTargets].join("\n");
  return createHash("sha256").update(canonicalPayload).digest("hex");
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Gmail's stable email ID is authoritative across mailbox views. Older IMAP
 * servers may not expose it, so fall back to a normalized Message-ID digest,
 * then to the mailbox-specific UID identity when neither global ID exists.
 */
export const buildReceiptDeduplicationKey = ({
  emailId,
  messageId,
  mailboxUidKey,
}: ReceiptDeduplicationIdentity): string => {
  const normalizedEmailId = emailId?.trim().toLowerCase();
  if (normalizedEmailId) {
    return `gmail-email-id:${sha256(normalizedEmailId)}`;
  }

  const normalizedMessageId = messageId?.trim();
  if (normalizedMessageId) {
    return `message-id:${sha256(normalizedMessageId)}`;
  }

  return `mailbox-uid:${sha256(mailboxUidKey)}`;
};

export const isSpecialUseMailboxCoverageComplete = (coverage: SpecialUseMailboxCoverage): boolean => {
  const mailboxScanComplete = (mailbox: SpecialUseMailboxCoverageEntry): boolean =>
    mailbox.scanned &&
    mailbox.openedReadOnly &&
    mailbox.highWaterUidBounded &&
    mailbox.complete &&
    mailbox.scanErrorCount === 0 &&
    mailbox.incompleteMessageCount === 0 &&
    mailbox.fetchedMessageCount === mailbox.searchMatchedMessageCount;
  const optionalMailboxCompleteWhenPresent = (mailbox: SpecialUseMailboxCoverageEntry): boolean =>
    !mailbox.present || mailboxScanComplete(mailbox);

  return (
    coverage.allMail.present &&
    mailboxScanComplete(coverage.allMail) &&
    optionalMailboxCompleteWhenPresent(coverage.junk) &&
    optionalMailboxCompleteWhenPresent(coverage.trash)
  );
};

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();

const setsMatch = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));

/**
 * Trust only Authentication-Results added by Gmail's MX. A forged message may
 * contain its own Authentication-Results header, so an arbitrary header is not
 * sufficient evidence.
 */
export const classifyVenmoAuthentication = (headers: string[]): VenmoAuthenticationStatus => {
  // Gmail prepends its result to received mail. Do not accept a later header
  // that a sender could have included in the original message.
  const trustedHeader = headers[0];
  if (!trustedHeader || !/\bmx\.google\.com\s*;/i.test(trustedHeader)) {
    return "unknown";
  }

  const venmoDomain = String.raw`(?:[a-z0-9-]+\.)*venmo\.com(?=[\s;]|$)`;
  const dmarcPass = new RegExp(String.raw`\bdmarc=pass\b[^;]*\bheader\.from=${venmoDomain}\b`, "i");
  const dkimPass = new RegExp(String.raw`\bdkim=pass\b[^;]*\bheader\.(?:d|i)=@?${venmoDomain}\b`, "i");

  if (dmarcPass.test(trustedHeader) || dkimPass.test(trustedHeader)) {
    return "pass";
  }

  if (/\b(?:dmarc|dkim)=(?:fail|permerror|temperror)\b/i.test(trustedHeader)) {
    return "fail";
  }

  return "unknown";
};

export const parseReceiptBodyPaidIds = ({ plaintext, html }: { plaintext?: string; html?: string }): ReceiptBodyIds => {
  const plaintextPaidIds = sortedUnique(parseVenmoPaidIds(plaintext ?? ""));
  let htmlPaidIds: string[] = [];
  let htmlConversionFailed = false;

  if (html) {
    try {
      const htmlText = convert(html, { wordwrap: false });
      htmlPaidIds = sortedUnique(parseVenmoPaidIds(htmlText));
    } catch {
      htmlConversionFailed = true;
    }
  }

  return {
    plaintextPaidIds,
    htmlPaidIds,
    paidIds: sortedUnique([...plaintextPaidIds, ...htmlPaidIds]),
    representationsDisagree: !setsMatch(plaintextPaidIds, htmlPaidIds),
    htmlConversionFailed,
  };
};

export const classifyReceipt = (input: ReceiptClassificationInput): ReceiptClassification => {
  const bodyIds = parseReceiptBodyPaidIds({ plaintext: input.plaintext, html: input.html });
  const normalizedSenders = input.fromAddresses.map((address) => address.trim().toLowerCase()).filter(Boolean);
  const exactSender = normalizedSenders.length === 1 && normalizedSenders[0] === VENMO_SENDER;
  const expectedSubject = isExpectedVenmoPaymentSubject(input.subject);
  const authenticationStatus = classifyVenmoAuthentication(input.authenticationHeaders);

  let status: ReceiptClassificationStatus;
  if (!exactSender) {
    status = "rejected_sender";
  } else if (!expectedSubject) {
    status = "rejected_subject";
  } else if (authenticationStatus === "fail") {
    status = "authentication_failed";
  } else if (authenticationStatus === "unknown") {
    status = "authentication_unknown";
  } else if (bodyIds.paidIds.length === 0) {
    status = "genuine_no_id";
  } else if (bodyIds.paidIds.length === 1) {
    status = "genuine_single_id";
  } else {
    status = "genuine_multiple_ids";
  }

  return {
    receiptKey: input.receiptKey,
    internalDate: input.internalDate,
    authenticationStatus,
    status,
    ...bodyIds,
  };
};

export const isGenuineReceipt = (
  receipt: ReceiptClassification,
): receipt is ReceiptClassification & {
  status: "genuine_no_id" | "genuine_single_id" | "genuine_multiple_ids";
} => receipt.status.startsWith("genuine_");

export const buildBackfillPlan = (
  receipts: ReceiptClassification[],
  rows: WatchedSectionPaymentRow[],
  clockSkewMs = DEFAULT_RECEIPT_CLOCK_SKEW_MS,
): BackfillPlan => {
  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) {
    throw new Error("clockSkewMs must be a non-negative safe integer");
  }

  const genuineReceipts = receipts.filter(isGenuineReceipt);
  const receiptEvidenceByPaidId = new Map<string, ReceiptClassification[]>();
  const paidIdsFromAmbiguousReceipts = new Set<string>();

  for (const receipt of genuineReceipts) {
    for (const paidId of receipt.paidIds) {
      const evidence = receiptEvidenceByPaidId.get(paidId) ?? [];
      evidence.push(receipt);
      receiptEvidenceByPaidId.set(paidId, evidence);
      if (receipt.paidIds.length !== 1) {
        paidIdsFromAmbiguousReceipts.add(paidId);
      }
    }
  }

  const rowsByPaidId = new Map<string, WatchedSectionPaymentRow[]>();
  for (const row of rows) {
    const matches = rowsByPaidId.get(row.paidId) ?? [];
    matches.push(row);
    rowsByPaidId.set(row.paidId, matches);
  }

  const stats: BackfillPlanStats = {
    uniquePaidIdCount: receiptEvidenceByPaidId.size,
    paidIdsSeenInMultipleReceiptsCount: 0,
    paidIdsFromAmbiguousReceiptsCount: paidIdsFromAmbiguousReceipts.size,
    unmatchedPaidIdCount: 0,
    paidIdsWithMultipleDbRowsCount: 0,
    alreadyPaidDbRowCount: 0,
    alreadyPaidPendingNotificationRowCount: 0,
    inconsistentUnpaidButNotifiedRowCount: 0,
    unpaidRowMissingCreatedAtCount: 0,
    paidIdWithoutUsableReceiptDateCount: 0,
    unpaidRowCreatedAfterReceiptCount: 0,
    eligibleRowCount: 0,
  };
  const applyCandidates: BackfillApplyCandidate[] = [];

  for (const [paidId, evidence] of receiptEvidenceByPaidId) {
    if (new Set(evidence.map((receipt) => receipt.receiptKey)).size > 1) {
      stats.paidIdsSeenInMultipleReceiptsCount += 1;
    }

    const matchingRows = rowsByPaidId.get(paidId) ?? [];
    if (matchingRows.length === 0) {
      stats.unmatchedPaidIdCount += 1;
      continue;
    }

    stats.alreadyPaidDbRowCount += matchingRows.filter((row) => row.isPaid).length;
    stats.alreadyPaidPendingNotificationRowCount += matchingRows.filter(
      (row) => row.isPaid && !row.paidNotified,
    ).length;
    stats.inconsistentUnpaidButNotifiedRowCount += matchingRows.filter((row) => !row.isPaid && row.paidNotified).length;

    // paidId is only unique per semester in the schema. Never guess between
    // rows if a historical collision exists, even if only one is currently unpaid.
    if (matchingRows.length !== 1) {
      stats.paidIdsWithMultipleDbRowsCount += 1;
      continue;
    }

    const row = matchingRows[0]!;
    if (row.isPaid || row.paidNotified || paidIdsFromAmbiguousReceipts.has(paidId)) {
      continue;
    }

    const receiptDates = evidence
      .flatMap((receipt) => (receipt.paidIds.length === 1 && receipt.internalDate ? [receipt.internalDate] : []))
      .sort((left, right) => left.getTime() - right.getTime());
    const earliestReceiptDate = receiptDates[0];
    if (!earliestReceiptDate) {
      stats.paidIdWithoutUsableReceiptDateCount += 1;
      continue;
    }

    if (!row.createdAt) {
      stats.unpaidRowMissingCreatedAtCount += 1;
      continue;
    }

    const receiptCutoff = new Date(earliestReceiptDate.getTime() + clockSkewMs);
    if (row.createdAt.getTime() > receiptCutoff.getTime()) {
      stats.unpaidRowCreatedAfterReceiptCount += 1;
      continue;
    }

    applyCandidates.push({ rowId: row.id, paidId, receiptCutoff });
  }

  applyCandidates.sort((left, right) => left.rowId.localeCompare(right.rowId));
  stats.eligibleRowCount = applyCandidates.length;

  return { applyCandidates, stats };
};
