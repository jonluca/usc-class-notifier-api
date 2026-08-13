import "dotenv/config";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import { prisma } from "@/server/db.ts";
import logger from "@/server/logger.ts";
import { isExpectedVenmoPaymentSubject, parseVenmoPaidIds } from "./venmoEmail.ts";

/**
 * ENV:
 *  GMAIL_IMAP_USER=yourname@gmail.com
 *  GMAIL_IMAP_APP_PASSWORD=xxxx xxxx xxxx xxxx   (16-char app password, spaces optional)
 */
export class GmailVenmoImapClient {
  private submitPaidIds = async (ids: string[]) => {
    const result = await prisma.watchedSection.updateMany({
      where: {
        paidId: {
          in: ids,
        },
        isPaid: false,
      },
      data: {
        isPaid: true,
      },
    });
    return result.count;
  };
  private parsePaidIds(text: string): string[] {
    return parseVenmoPaidIds(text);
  }

  private normalizeBody(parsed: Awaited<ReturnType<typeof simpleParser>>): string {
    if (parsed.text && parsed.text.trim()) {
      return parsed.text;
    }

    if (parsed.html) {
      return convert(parsed.html.toString(), { wordwrap: false });
    }

    return "";
  }

  async fetchVenmoPaidYouIds(): Promise<string[]> {
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

    const allPaidIds: string[] = [];

    try {
      await client.connect();

      // Gmail supports the "All Mail" mailbox for searching across archived+inbox.
      // If it doesn't exist (rare), fall back to INBOX.
      const gmailAllMail = "[Gmail]/All Mail";
      try {
        await client.mailboxOpen(gmailAllMail);
      } catch {
        await client.mailboxOpen("INBOX");
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

      for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true })) {
        const subject = msg.envelope?.subject ?? "";

        // Match your prior logic
        if (!isExpectedVenmoPaymentSubject(subject)) {
          continue;
        }

        const text = msg.source?.toString();
        if (!text) {
          continue;
        }
        const parsed = await simpleParser(text);
        const bodyText = this.normalizeBody(parsed);

        const ids = this.parsePaidIds(bodyText);
        if (ids.length) {
          allPaidIds.push(...ids);
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

    return allPaidIds;
  }

  checkEmails = async (): Promise<void> => {
    const paidIds = await this.fetchVenmoPaidYouIds();
    if (paidIds.length === 0) {
      logger.info("Venmo Gmail scan completed: 0 payment IDs found");
      return;
    }

    const uniquePaidIds = [...new Set(paidIds)];
    const updatedCount = await this.submitPaidIds(uniquePaidIds);
    logger.info(
      `Venmo Gmail scan completed: ${uniquePaidIds.length} payment IDs found, ${updatedCount} sections newly marked paid`,
    );
  };
}
