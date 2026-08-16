import "dotenv/config";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { prisma } from "@/server/db.ts";
import logger from "@/server/logger.ts";
import { getValidSemesters } from "@/utils/semester.ts";
import { classifyReceipt } from "./backfillReconciliation.ts";
import {
  isReceiptEligibleForRow,
  reconcilePaymentReference,
  selectSinglePaymentReference,
  type PaymentReceiptReference,
} from "./paymentReconciliation.ts";

/**
 * ENV:
 *  GMAIL_IMAP_USER=yourname@gmail.com
 *  GMAIL_IMAP_APP_PASSWORD=xxxx xxxx xxxx xxxx   (16-char app password, spaces optional)
 */
export class GmailVenmoImapClient {
  private submitPayments = async (receipts: PaymentReceiptReference[]) => {
    const receiptsByPaidId = new Map<string, PaymentReceiptReference[]>();
    for (const receipt of receipts) {
      const matchingReceipts = receiptsByPaidId.get(receipt.paidId) || [];
      matchingReceipts.push(receipt);
      receiptsByPaidId.set(receipt.paidId, matchingReceipts);
    }
    const paidIds = [...receiptsByPaidId.keys()];
    const rows = await prisma.watchedSection.findMany({
      where: { paidId: { in: paidIds } },
      select: {
        id: true,
        createdAt: true,
        paidId: true,
        semester: true,
        isPaid: true,
      },
    });
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
          const hasEligibleReceipt = (receiptsByPaidId.get(paidId) || []).some((receipt) =>
            isReceiptEligibleForRow(receipt, reconciliation.row),
          );
          if (!hasEligibleReceipt) {
            predatesSectionCount += 1;
            break;
          }
          const update = await prisma.watchedSection.updateMany({
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
  async fetchVenmoPayments(): Promise<PaymentReceiptReference[]> {
    const user = process.env.GMAIL_IMAP_USER;
    const pass = process.env.GMAIL_IMAP_APP_PASSWORD;

    if (!user) {
      throw new Error("GMAIL_IMAP_USER not set");
    }
    if (!pass) {
      throw new Error("GMAIL_IMAP_APP_PASSWORD not set");
    }

    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: {
        user,
        pass: pass.replace(/\s+/g, ""), // app password sometimes pasted with spaces
      },
      logger: false,
    });

    const receipts: PaymentReceiptReference[] = [];
    let ambiguousReceiptCount = 0;
    let unauthenticatedReceiptCount = 0;

    try {
      await client.connect();

      // Gmail supports the "All Mail" mailbox for searching across archived+inbox.
      // If it doesn't exist (rare), fall back to INBOX.
      const gmailAllMail = "[Gmail]/All Mail";
      try {
        await client.mailboxOpen(gmailAllMail, { readOnly: true });
      } catch {
        await client.mailboxOpen("INBOX", { readOnly: true });
      }

      // Keep enough overlap to recover after an extended deployment or provider outage.
      // The database update is idempotent, so refetching this bounded window is safe.
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const uids = await client.search({
        since,
        from: "venmo@venmo.com",
      });

      if (!uids || uids.length === 0) {
        logger.info("Venmo Gmail scan completed: 0 messages found");
        return [];
      }
      // Fetch newest first
      uids.sort((a, b) => b - a);

      for await (const msg of client.fetch(uids, { uid: true, envelope: true, internalDate: true, source: true })) {
        const text = msg.source?.toString();
        if (!text) {
          continue;
        }
        const parsed = await simpleParser(text, {
          skipHtmlToText: true,
          skipTextToHtml: true,
        });
        const authenticationHeaders: string[] = [];
        for (const header of parsed.headerLines) {
          if (header.key.toLowerCase() === "authentication-results") {
            authenticationHeaders.push(header.line);
          }
        }
        const classification = classifyReceipt({
          receiptKey: `uid:${msg.uid}`,
          internalDate: msg.internalDate instanceof Date ? msg.internalDate : null,
          subject: parsed.subject ?? msg.envelope?.subject ?? "",
          fromAddresses:
            parsed.from?.value.flatMap((entry) => {
              if (entry.address) {
                return [entry.address];
              }
              const groupAddresses: string[] = [];
              for (const member of entry.group || []) {
                if (member.address) {
                  groupAddresses.push(member.address);
                }
              }
              return groupAddresses;
            }) ?? [],
          authenticationHeaders,
          plaintext: parsed.text,
          html: parsed.html === false ? undefined : parsed.html,
        });
        const paidId = selectSinglePaymentReference(classification.paidIds);
        if (classification.status === "genuine_single_id" && paidId && classification.internalDate) {
          receipts.push({ paidId, receivedAt: classification.internalDate });
        } else if (classification.status === "genuine_multiple_ids") {
          ambiguousReceiptCount += 1;
        } else if (
          classification.status === "authentication_failed" ||
          classification.status === "authentication_unknown"
        ) {
          unauthenticatedReceiptCount += 1;
        }
      }
    } finally {
      // close connection cleanly
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }

    if (ambiguousReceiptCount > 0) {
      logger.warn(`Venmo Gmail scan skipped ${ambiguousReceiptCount} receipts containing multiple payment references`);
    }
    if (unauthenticatedReceiptCount > 0) {
      logger.warn(`Venmo Gmail scan skipped ${unauthenticatedReceiptCount} receipts that failed sender authentication`);
    }

    return receipts;
  }

  checkEmails = async (): Promise<void> => {
    const receipts = await this.fetchVenmoPayments();
    if (receipts.length === 0) {
      logger.info("Venmo Gmail scan completed: 0 payment IDs found");
      return;
    }

    const uniquePaidIds = [...new Set(receipts.map((receipt) => receipt.paidId))];
    const updatedCount = await this.submitPayments(receipts);
    logger.info(
      `Venmo Gmail scan completed: ${uniquePaidIds.length} payment IDs found, ${updatedCount} sections newly marked paid`,
    );
  };
}
