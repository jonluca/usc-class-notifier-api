import "dotenv/config";

import { ImapFlow } from "imapflow";
import type { ListResponse } from "imapflow";
import { simpleParser } from "mailparser";
import type { EmailAddress } from "mailparser";
import { prisma } from "@/server/db.ts";
import {
  BACKFILL_APPLY_CONFIRMATION,
  buildReceiptDeduplicationKey,
  buildBackfillPlan,
  calculateTargetFingerprint,
  classifyReceipt,
  isGenuineReceipt,
  isSpecialUseMailboxCoverageComplete,
  parseBackfillArgs,
  VENMO_SENDER,
} from "./backfillReconciliation.ts";
import type {
  BackfillApplyCandidate,
  BackfillCliOptions,
  ReceiptClassification,
  ReceiptClassificationStatus,
  SpecialUseMailboxCoverage,
  SpecialUseMailboxCoverageEntry,
  WatchedSectionPaymentRow,
} from "./backfillReconciliation.ts";

const DB_QUERY_CHUNK_SIZE = 1_000;

interface ScanStats {
  searchMatchedMessageCount: number;
  fetchedMessageCount: number;
  deduplicatedMessageCount: number;
  missingFetchedMessageCount: number;
  missingSourceMessageCount: number;
  oversizedMessageCount: number;
  parseErrorMessageCount: number;
  htmlConversionErrorMessageCount: number;
  mailboxScanErrorCount: number;
  representationDisagreementMessageCount: number;
  rejectedSenderMessageCount: number;
  rejectedSubjectMessageCount: number;
  authenticationFailedMessageCount: number;
  authenticationUnknownMessageCount: number;
  genuineOneDollarReceiptCount: number;
  genuineNoPaidIdReceiptCount: number;
  genuineSinglePaidIdReceiptCount: number;
  genuineMultiplePaidIdsReceiptCount: number;
}

interface ScanResult {
  complete: boolean;
  mailboxCoverage: SpecialUseMailboxCoverage;
  receipts: ReceiptClassification[];
  stats: ScanStats;
}

interface ApplyResult {
  attemptedRowCount: number;
  updatedRowCount: number;
  guardMissRowCount: number;
}

interface DatabasePreflightStats {
  totalRowCount: number;
  duplicatePaidIdGroupCount: number;
  legacyNonEightDigitPaidIdRowCount: number;
  inconsistentUnpaidButNotifiedRowCount: number;
  missingCreatedAtRowCount: number;
}

interface DatabasePreflightRawRow {
  totalRowCount: bigint;
  duplicatePaidIdGroupCount: bigint;
  legacyNonEightDigitPaidIdRowCount: bigint;
  inconsistentUnpaidButNotifiedRowCount: bigint;
  missingCreatedAtRowCount: bigint;
}

const createScanStats = (): ScanStats => ({
  searchMatchedMessageCount: 0,
  fetchedMessageCount: 0,
  deduplicatedMessageCount: 0,
  missingFetchedMessageCount: 0,
  missingSourceMessageCount: 0,
  oversizedMessageCount: 0,
  parseErrorMessageCount: 0,
  htmlConversionErrorMessageCount: 0,
  mailboxScanErrorCount: 0,
  representationDisagreementMessageCount: 0,
  rejectedSenderMessageCount: 0,
  rejectedSubjectMessageCount: 0,
  authenticationFailedMessageCount: 0,
  authenticationUnknownMessageCount: 0,
  genuineOneDollarReceiptCount: 0,
  genuineNoPaidIdReceiptCount: 0,
  genuineSinglePaidIdReceiptCount: 0,
  genuineMultiplePaidIdsReceiptCount: 0,
});

const createMailboxCoverageEntry = (present: boolean): SpecialUseMailboxCoverageEntry => ({
  present,
  scanned: false,
  openedReadOnly: false,
  highWaterUidBounded: false,
  complete: false,
  searchMatchedMessageCount: 0,
  fetchedMessageCount: 0,
  deduplicatedMessageCount: 0,
  incompleteMessageCount: 0,
  scanErrorCount: 0,
});

const chunk = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const flattenAddresses = (addresses: EmailAddress[]): string[] =>
  addresses.flatMap((entry) => {
    if (entry.address) {
      return [entry.address];
    }
    return entry.group ? flattenAddresses(entry.group) : [];
  });

const toValidDate = (value: Date | string | undefined): Date | null => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const incrementClassificationStats = (stats: ScanStats, status: ReceiptClassificationStatus) => {
  const keyByStatus = {
    rejected_sender: "rejectedSenderMessageCount",
    rejected_subject: "rejectedSubjectMessageCount",
    authentication_failed: "authenticationFailedMessageCount",
    authentication_unknown: "authenticationUnknownMessageCount",
    genuine_no_id: "genuineNoPaidIdReceiptCount",
    genuine_single_id: "genuineSinglePaidIdReceiptCount",
    genuine_multiple_ids: "genuineMultiplePaidIdsReceiptCount",
  } satisfies Record<ReceiptClassificationStatus, keyof ScanStats>;
  stats[keyByStatus[status]] += 1;
  if (status.startsWith("genuine_")) {
    stats.genuineOneDollarReceiptCount += 1;
  }
};

const findSpecialUseMailbox = (
  mailboxes: ListResponse[],
  specialUse: "\\All" | "\\Junk" | "\\Trash",
  fallbackPaths: string[],
): ListResponse | undefined =>
  mailboxes.find((mailbox) => mailbox.specialUse === specialUse) ??
  mailboxes.find((mailbox) => fallbackPaths.some((path) => mailbox.path.toLowerCase() === path.toLowerCase()));

const scanAllRelevantMailboxes = async (options: BackfillCliOptions): Promise<ScanResult> => {
  const user = process.env.GMAIL_IMAP_USER;
  const password = process.env.GMAIL_IMAP_APP_PASSWORD;
  if (!user) {
    throw new Error("GMAIL_IMAP_USER is not set");
  }
  if (!password) {
    throw new Error("GMAIL_IMAP_APP_PASSWORD is not set");
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass: password.replace(/\s+/g, "") },
    logger: false,
  });
  const stats = createScanStats();
  const receipts: ReceiptClassification[] = [];
  const seenReceiptKeys = new Set<string>();
  let mailboxCoverage: SpecialUseMailboxCoverage = {
    allMail: createMailboxCoverageEntry(false),
    junk: createMailboxCoverageEntry(false),
    trash: createMailboxCoverageEntry(false),
  };

  try {
    await client.connect();
    const mailboxes = await client.list();
    const selectedMailboxes = {
      allMail: findSpecialUseMailbox(mailboxes, "\\All", ["[Gmail]/All Mail", "[Google Mail]/All Mail"]),
      junk: findSpecialUseMailbox(mailboxes, "\\Junk", ["[Gmail]/Spam", "[Google Mail]/Spam"]),
      trash: findSpecialUseMailbox(mailboxes, "\\Trash", ["[Gmail]/Trash", "[Google Mail]/Trash"]),
    };
    mailboxCoverage = {
      allMail: createMailboxCoverageEntry(Boolean(selectedMailboxes.allMail)),
      junk: createMailboxCoverageEntry(Boolean(selectedMailboxes.junk)),
      trash: createMailboxCoverageEntry(Boolean(selectedMailboxes.trash)),
    };

    for (const role of ["allMail", "junk", "trash"] as const) {
      const selectedMailbox = selectedMailboxes[role];
      const coverage = mailboxCoverage[role];
      if (!selectedMailbox) {
        continue;
      }

      coverage.scanned = true;
      try {
        const mailbox = await client.mailboxOpen(selectedMailbox.path, { readOnly: true });
        if (!mailbox.readOnly) {
          throw new Error("Special-use mailbox could not be opened read-only");
        }
        coverage.openedReadOnly = true;

        // Give every mailbox its own stable high-water UID. Messages arriving
        // during this run are left to the normal job or a later backfill rerun.
        const maximumUid = mailbox.uidNext - 1;
        coverage.highWaterUidBounded = true;
        if (maximumUid >= 1) {
          const searchResult = await client.search(
            {
              uid: `1:${maximumUid}`,
              from: VENMO_SENDER,
            },
            { uid: true },
          );
          const uids = Array.isArray(searchResult) ? [...searchResult].sort((left, right) => left - right) : [];
          coverage.searchMatchedMessageCount = uids.length;
          stats.searchMatchedMessageCount += uids.length;

          for (const uidChunk of chunk(uids, options.chunkSize)) {
            for await (const message of client.fetch(
              uidChunk,
              {
                uid: true,
                internalDate: true,
                size: true,
                source: { maxLength: options.maxMessageBytes + 1 },
              },
              { uid: true },
            )) {
              // ImapFlow automatically requests EMAILID or X-GM-MSGID when
              // the server advertises either capability; there is no emailId
              // FetchQueryObject flag in this installed API.
              coverage.fetchedMessageCount += 1;
              stats.fetchedMessageCount += 1;

              if (
                (message.size !== undefined && message.size > options.maxMessageBytes) ||
                (message.source?.length ?? 0) > options.maxMessageBytes
              ) {
                coverage.incompleteMessageCount += 1;
                stats.oversizedMessageCount += 1;
                continue;
              }
              if (!message.source) {
                coverage.incompleteMessageCount += 1;
                stats.missingSourceMessageCount += 1;
                continue;
              }

              try {
                // Keep the two representations independent so a sparse
                // text/plain alternative cannot hide an HTML-only paid ID.
                const parsed = await simpleParser(message.source, {
                  skipHtmlToText: true,
                  skipTextToHtml: true,
                  maxHtmlLengthToParse: options.maxMessageBytes,
                });
                const deduplicationKey = buildReceiptDeduplicationKey({
                  emailId: message.emailId,
                  messageId: parsed.messageId,
                  mailboxUidKey: `${role}:${mailbox.uidValidity}:${message.uid}`,
                });
                if (seenReceiptKeys.has(deduplicationKey)) {
                  coverage.deduplicatedMessageCount += 1;
                  stats.deduplicatedMessageCount += 1;
                  continue;
                }
                seenReceiptKeys.add(deduplicationKey);

                const fromAddresses = parsed.from ? flattenAddresses(parsed.from.value) : [];
                const authenticationHeaders = parsed.headerLines
                  .filter((header) => header.key.toLowerCase() === "authentication-results")
                  .map((header) => header.line);
                const classification = classifyReceipt({
                  receiptKey: deduplicationKey,
                  internalDate: toValidDate(message.internalDate),
                  subject: parsed.subject ?? "",
                  fromAddresses,
                  authenticationHeaders,
                  plaintext: parsed.text,
                  html: parsed.html === false ? undefined : parsed.html,
                });

                incrementClassificationStats(stats, classification.status);
                if (classification.representationsDisagree) {
                  stats.representationDisagreementMessageCount += 1;
                }
                if (classification.htmlConversionFailed) {
                  coverage.incompleteMessageCount += 1;
                  stats.htmlConversionErrorMessageCount += 1;
                }
                if (isGenuineReceipt(classification)) {
                  // Retain hashes, dates, statuses, and small ID sets only. Raw
                  // MIME, subject, sender names, and bodies leave scope here.
                  receipts.push(classification);
                }
              } catch {
                coverage.incompleteMessageCount += 1;
                stats.parseErrorMessageCount += 1;
              }
            }

            if (stats.fetchedMessageCount > 0 && stats.fetchedMessageCount % 500 === 0) {
              process.stderr.write(
                `Scanned ${stats.fetchedMessageCount}/${stats.searchMatchedMessageCount} candidate mailbox views\n`,
              );
            }
          }
        }
      } catch {
        coverage.scanErrorCount += 1;
        stats.mailboxScanErrorCount += 1;
      } finally {
        const missingFetchedMessageCount = Math.max(
          0,
          coverage.searchMatchedMessageCount - coverage.fetchedMessageCount,
        );
        coverage.incompleteMessageCount += missingFetchedMessageCount;
        stats.missingFetchedMessageCount += missingFetchedMessageCount;
        coverage.complete =
          coverage.openedReadOnly &&
          coverage.highWaterUidBounded &&
          coverage.scanErrorCount === 0 &&
          coverage.incompleteMessageCount === 0;
      }
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // The scan result remains useful if Gmail closes an otherwise completed
      // read-only connection before LOGOUT finishes.
    }
  }

  const complete =
    isSpecialUseMailboxCoverageComplete(mailboxCoverage) &&
    stats.missingFetchedMessageCount === 0 &&
    stats.missingSourceMessageCount === 0 &&
    stats.oversizedMessageCount === 0 &&
    stats.parseErrorMessageCount === 0 &&
    stats.htmlConversionErrorMessageCount === 0 &&
    stats.mailboxScanErrorCount === 0;

  return { complete, mailboxCoverage, receipts, stats };
};

const toSafeCount = (value: bigint, name: string): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${name} exceeded the safe reporting range`);
  }
  return count;
};

const loadDatabasePreflightStats = async (): Promise<DatabasePreflightStats> => {
  const [raw] = await prisma.$queryRaw<DatabasePreflightRawRow[]>`
    SELECT
      COUNT(*)::bigint AS "totalRowCount",
      COUNT(*) FILTER (WHERE "paidId" !~ '^[0-9]{8}$')::bigint AS "legacyNonEightDigitPaidIdRowCount",
      COUNT(*) FILTER (WHERE NOT "isPaid" AND "paidNotified")::bigint AS "inconsistentUnpaidButNotifiedRowCount",
      COUNT(*) FILTER (WHERE "createdAt" IS NULL)::bigint AS "missingCreatedAtRowCount",
      (
        SELECT COUNT(*)::bigint
        FROM (
          SELECT "paidId"
          FROM "WatchedSection"
          GROUP BY "paidId"
          HAVING COUNT(*) > 1
        ) AS duplicate_groups
      ) AS "duplicatePaidIdGroupCount"
    FROM "WatchedSection"
  `;
  if (!raw) {
    throw new Error("Database preflight query returned no result");
  }
  return {
    totalRowCount: toSafeCount(raw.totalRowCount, "totalRowCount"),
    duplicatePaidIdGroupCount: toSafeCount(raw.duplicatePaidIdGroupCount, "duplicatePaidIdGroupCount"),
    legacyNonEightDigitPaidIdRowCount: toSafeCount(
      raw.legacyNonEightDigitPaidIdRowCount,
      "legacyNonEightDigitPaidIdRowCount",
    ),
    inconsistentUnpaidButNotifiedRowCount: toSafeCount(
      raw.inconsistentUnpaidButNotifiedRowCount,
      "inconsistentUnpaidButNotifiedRowCount",
    ),
    missingCreatedAtRowCount: toSafeCount(raw.missingCreatedAtRowCount, "missingCreatedAtRowCount"),
  };
};

const loadMatchingRows = async (paidIds: string[]): Promise<WatchedSectionPaymentRow[]> => {
  const rows: WatchedSectionPaymentRow[] = [];
  for (const paidIdChunk of chunk(paidIds, DB_QUERY_CHUNK_SIZE)) {
    rows.push(
      ...(await prisma.watchedSection.findMany({
        where: { paidId: { in: paidIdChunk } },
        select: {
          id: true,
          paidId: true,
          createdAt: true,
          isPaid: true,
          paidNotified: true,
        },
      })),
    );
  }
  return rows;
};

const countUnpaidTargets = async (candidates: BackfillApplyCandidate[]): Promise<number> => {
  let count = 0;
  for (const candidateChunk of chunk(candidates, DB_QUERY_CHUNK_SIZE)) {
    count += await prisma.watchedSection.count({
      where: {
        id: { in: candidateChunk.map((candidate) => candidate.rowId) },
        isPaid: false,
      },
    });
  }
  return count;
};

const applyCandidates = async (candidates: BackfillApplyCandidate[]): Promise<ApplyResult> => {
  const result: ApplyResult = {
    attemptedRowCount: candidates.length,
    updatedRowCount: 0,
    guardMissRowCount: 0,
  };

  for (const candidate of candidates) {
    const updatedCount = await prisma.$transaction(
      async (transaction) => {
        const matchingRowCount = await transaction.watchedSection.count({
          where: { paidId: candidate.paidId },
        });
        const eligibleRowCount = await transaction.watchedSection.count({
          where: {
            paidId: candidate.paidId,
            id: candidate.rowId,
            isPaid: false,
            paidNotified: false,
            createdAt: { not: null, lte: candidate.receiptCutoff },
          },
        });
        if (matchingRowCount !== 1 || eligibleRowCount !== 1) {
          return 0;
        }

        const update = await transaction.watchedSection.updateMany({
          where: {
            paidId: candidate.paidId,
            id: candidate.rowId,
            isPaid: false,
            paidNotified: false,
            createdAt: { not: null, lte: candidate.receiptCutoff },
          },
          data: { isPaid: true },
        });
        return update.count;
      },
      { isolationLevel: "Serializable" },
    );

    if (updatedCount === 1) {
      result.updatedRowCount += 1;
    } else {
      result.guardMissRowCount += 1;
    }
  }

  return result;
};

const helpText = `Usage: pnpm exec tsx jobs/venmoGmail/backfill.ts [options]

Dry-run is the default and performs no database writes.

Options:
  --apply
  --confirm=${BACKFILL_APPLY_CONFIRMATION}
  --expected-target-count=<count from dry run>
  --expected-target-sha256=<sha256 from dry run>
  --chunk-size=50
  --max-message-bytes=5242880
  --clock-skew-seconds=300
  --help
`;

const run = async () => {
  const options = parseBackfillArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText);
    return;
  }
  if (!process.env.POSTGRES_PRISMA_URL) {
    throw new Error("POSTGRES_PRISMA_URL is not set");
  }

  const startedAt = new Date();
  const databasePreflight = await loadDatabasePreflightStats();
  const scan = await scanAllRelevantMailboxes(options);
  const paidIds = [...new Set(scan.receipts.flatMap((receipt) => receipt.paidIds))].sort();
  const rows = await loadMatchingRows(paidIds);
  const plan = buildBackfillPlan(scan.receipts, rows, options.clockSkewMs);
  const pendingNotificationsBefore = await prisma.watchedSection.count({
    where: { isPaid: true, paidNotified: false },
  });
  const targetCount = plan.applyCandidates.length;
  const targetSha256 = calculateTargetFingerprint(plan.applyCandidates);
  const targetUnpaidBefore = await countUnpaidTargets(plan.applyCandidates);

  let applyResult: ApplyResult = {
    attemptedRowCount: 0,
    updatedRowCount: 0,
    guardMissRowCount: 0,
  };
  const applyBlockReasons: string[] = [];
  if (options.apply && !scan.complete) {
    applyBlockReasons.push("incomplete_scan");
  }
  if (options.apply && options.expectedTargetCount !== targetCount) {
    applyBlockReasons.push("expected_target_count_mismatch");
  }
  if (options.apply && options.expectedTargetSha256 !== targetSha256) {
    applyBlockReasons.push("expected_target_sha256_mismatch");
  }
  if (options.apply && targetUnpaidBefore !== targetCount) {
    applyBlockReasons.push("target_preflight_unpaid_count_mismatch");
  }
  const applyBlocked = applyBlockReasons.length > 0;

  if (options.apply && !applyBlocked) {
    applyResult = await applyCandidates(plan.applyCandidates);
  }

  const pendingNotificationsAfter = options.apply
    ? await prisma.watchedSection.count({ where: { isPaid: true, paidNotified: false } })
    : pendingNotificationsBefore;
  const targetUnpaidAfter = await countUnpaidTargets(plan.applyCandidates);
  const postApplyTargetVerificationPassed = options.apply && !applyBlocked ? targetUnpaidAfter === 0 : null;
  const report = {
    version: 1,
    mode: options.apply ? "apply" : "dry-run",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    coverage: {
      mailboxes: ["gmail-all-mail", "gmail-junk-if-present", "gmail-trash-if-present"],
      lifetimeDateFilter: false,
      readOnlyImap: true,
      uidHighWaterBounded: true,
      complete: scan.complete,
      specialUseMailboxes: scan.mailboxCoverage,
    },
    options: {
      chunkSize: options.chunkSize,
      clockSkewSeconds: options.clockSkewMs / 1000,
      maxMessageBytes: options.maxMessageBytes,
    },
    scan: scan.stats,
    databasePreflight,
    reconciliation: plan.stats,
    targets: {
      count: targetCount,
      sha256: targetSha256,
      unpaidBefore: targetUnpaidBefore,
      unpaidAfter: targetUnpaidAfter,
    },
    notifications: {
      pendingBefore: pendingNotificationsBefore,
      projectedPendingAfterApply: pendingNotificationsBefore + plan.applyCandidates.length,
      pendingAfter: pendingNotificationsAfter,
      sentByThisScript: 0,
    },
    apply: {
      requested: options.apply,
      blocked: applyBlocked,
      blockReasons: applyBlockReasons,
      expectedTargetCountMatched: options.apply ? options.expectedTargetCount === targetCount : null,
      expectedTargetSha256Matched: options.apply ? options.expectedTargetSha256 === targetSha256 : null,
      postApplyTargetVerificationPassed,
      wouldUpdateRowCount: targetCount,
      ...applyResult,
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (applyBlocked) {
    process.exitCode = 2;
  } else if (options.apply && !postApplyTargetVerificationPassed) {
    process.exitCode = 3;
  }
};

const sanitizedErrorMessage = (error: Error): string => {
  let { message } = error;
  for (const secret of [
    process.env.GMAIL_IMAP_USER,
    process.env.GMAIL_IMAP_APP_PASSWORD,
    process.env.POSTGRES_PRISMA_URL,
  ]) {
    if (secret) {
      message = message.replaceAll(secret, "[redacted]");
    }
  }
  return message.slice(0, 500);
};

void run()
  .catch((error) => {
    const failure = error instanceof Error ? error : new Error("Unknown error");
    process.stderr.write(`Venmo backfill failed: ${sanitizedErrorMessage(failure)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
