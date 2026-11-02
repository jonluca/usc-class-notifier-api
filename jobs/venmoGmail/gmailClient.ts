import "dotenv/config";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { prisma, type PrismaClientType } from "@/server/db.ts";
import logger from "@/server/logger.ts";
import { getD1Executor } from "@/server/d1/executor";
import { markD1PaymentPaid } from "./d1Payments";
import { getValidSemesters } from "@/utils/semester.ts";
import {
  isReceiptEligibleForRow,
  reconcilePaymentReference,
  type PaymentReceiptReference,
} from "./paymentReconciliation.ts";

import {
  fetchGmailPage,
  gmailImapOptions,
  type GmailCursor,
  type GmailImapSession,
  type GmailPageOptions,
  type GmailPageResult,
  type GmailPageSummary,
} from "./gmailPagination";

export interface GmailClientOptions {
  database?: PrismaClientType;
  createImapClient?: (options: ImapFlowOptions) => GmailImapSession;
  transport?: ImapFlowOptions["transport"];
  now?: () => number;
}
export interface GmailCheckPageResult {
  summary: GmailPageSummary & { updatedCount: number };
  nextCursor: GmailCursor | null;
}

/**
 * ENV:
 *  GMAIL_IMAP_USER=yourname@gmail.com
 *  GMAIL_IMAP_APP_PASSWORD=xxxx xxxx xxxx xxxx   (16-char app password, spaces optional)
 */
export class GmailVenmoImapClient {
  private readonly database: PrismaClientType;
  constructor(private readonly options: GmailClientOptions = {}) {
    this.database = options.database ?? prisma;
  }
  private submitPayments = async (receipts: PaymentReceiptReference[]) => {
    const receiptsByPaidId = new Map<string, PaymentReceiptReference[]>();
    for (const receipt of receipts) {
      const matchingReceipts = receiptsByPaidId.get(receipt.paidId) || [];
      matchingReceipts.push(receipt);
      receiptsByPaidId.set(receipt.paidId, matchingReceipts);
    }
    const paidIds = [...receiptsByPaidId.keys()];
    const d1 = getD1Executor(this.database);
    const rows = [];
    const batchSize = d1 ? 80 : 1_000;
    for (let offset = 0; offset < paidIds.length; offset += batchSize) {
      rows.push(
        ...(await this.database.watchedSection.findMany({
          where: { paidId: { in: paidIds.slice(offset, offset + batchSize) } },
          select: { id: true, createdAt: true, paidId: true, semester: true, isPaid: true },
        })),
      );
    }
    const monitoredSemesters = getValidSemesters();
    let updatedCount = 0;
    let unmatchedCount = 0;
    let ambiguousCount = 0;
    let unmonitoredCount = 0;
    let guardMissCount = 0;
    let predatesSectionCount = 0;

    for (const paidId of paidIds) {
      const reconciliation = reconcilePaymentReference(paidId, rows, monitoredSemesters);
      switch (reconciliation.status) {
        case "unmatched":
          unmatchedCount += 1;
          break;
        case "ambiguous":
          ambiguousCount += 1;
          break;
        case "unmonitored":
          unmonitoredCount += 1;
          break;
        case "already_paid":
          break;
        case "eligible": {
          const eligibleReceipt = (receiptsByPaidId.get(paidId) || []).find((receipt) =>
            isReceiptEligibleForRow(receipt, reconciliation.row),
          );
          if (!eligibleReceipt) {
            predatesSectionCount += 1;
            break;
          }
          const update = d1
            ? {
                count: await markD1PaymentPaid(d1, {
                  rowId: reconciliation.row.id,
                  paidId,
                  semester: reconciliation.row.semester,
                  receiptCutoff: new Date(eligibleReceipt.receivedAt.getTime() + 5 * 60 * 1000),
                }),
              }
            : await this.database.watchedSection.updateMany({
                where: {
                  id: reconciliation.row.id,
                  paidId,
                  semester: reconciliation.row.semester,
                  isPaid: false,
                },
                data: { isPaid: true },
              });
          if (update.count === 1) {
            updatedCount += 1;
          } else {
            guardMissCount += 1;
          }
          break;
        }
      }
    }

    if (unmatchedCount || ambiguousCount || unmonitoredCount || predatesSectionCount || guardMissCount) {
      logger.warn(
        `Venmo payment reconciliation alert: ${unmatchedCount} unmatched, ${ambiguousCount} ambiguous, ${unmonitoredCount} unmonitored-semester, ${predatesSectionCount} predated-section, ${guardMissCount} guarded-update misses; all skipped`,
      );
    }

    return updatedCount;
  };
  /** A fetch-only page never marks a payment or sends a notification. */
  fetchPage(options: GmailPageOptions = {}): Promise<GmailPageResult> {
    const user = process.env.GMAIL_IMAP_USER;
    const pass = process.env.GMAIL_IMAP_APP_PASSWORD;
    if (!user || !pass?.replace(/\s+/g, "")) {
      throw new Error("Gmail IMAP credentials are not configured");
    }
    const configuration = gmailImapOptions(user, pass, this.options.transport);
    const client = this.options.createImapClient?.(configuration) ?? new ImapFlow(configuration);
    return fetchGmailPage(client, options, this.options.now?.() ?? Date.now());
  }

  async checkPage(options: GmailPageOptions = {}): Promise<GmailCheckPageResult> {
    const page = await this.fetchPage(options);
    if (page.summary.ambiguousReceipts || page.summary.unauthenticatedReceipts) {
      logger.warn(
        `Venmo Gmail page skipped ${page.summary.ambiguousReceipts} ambiguous and ${page.summary.unauthenticatedReceipts} unauthenticated receipts`,
      );
    }
    const updatedCount = page.receipts.length ? await this.submitPayments(page.receipts) : 0;
    return { summary: { ...page.summary, updatedCount }, nextCursor: page.nextCursor };
  }

  async fetchVenmoPayments(): Promise<PaymentReceiptReference[]> {
    const receipts: PaymentReceiptReference[] = [];
    let cursor: GmailCursor | undefined;
    do {
      const page = await this.fetchPage({ cursor });
      receipts.push(...page.receipts);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return receipts;
  }

  checkEmails = async (): Promise<void> => {
    let cursor: GmailCursor | undefined;
    let receiptCount = 0;
    let updatedCount = 0;
    do {
      const page = await this.checkPage({ cursor });
      receiptCount += page.summary.genuineReceipts;
      updatedCount += page.summary.updatedCount;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    logger.info(
      `Venmo Gmail scan completed: ${receiptCount} authenticated receipts found, ${updatedCount} sections newly marked paid`,
    );
  };
}
