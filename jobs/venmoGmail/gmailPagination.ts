import type {
  FetchMessageObject,
  FetchOptions,
  FetchQueryObject,
  ImapFlowOptions,
  MessageRange,
  SearchObject,
} from "imapflow";
import { simpleParser } from "mailparser";
import { z } from "zod";
import { classifyReceipt } from "./backfillReconciliation";
import { selectSinglePaymentReference, type PaymentReceiptReference } from "./paymentReconciliation";

export const GMAIL_PAGE_SIZE = 100;
export const GMAIL_MESSAGE_BYTES = 4 * 1024 * 1024;
export const GMAIL_PAGE_BYTES = 8 * 1024 * 1024;
export const GMAIL_PAGE_TIMEOUT_MS = 120_000;
const MAX_UID = 4_294_967_295;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const mailboxSchema = z.enum(["[Gmail]/All Mail", "INBOX"]);
export const gmailCursorSchema = z
  .object({
    version: z.literal(1),
    scanSince: z.number().int().min(0).max(8_640_000_000_000_000),
    mailbox: mailboxSchema,
    uidValidity: z.string().regex(/^[1-9]\d*$/),
    upperUid: z.number().int().min(0).max(MAX_UID),
    afterUid: z.number().int().min(0).max(MAX_UID),
  })
  .strict()
  .refine((cursor) => cursor.afterUid <= cursor.upperUid);
export type GmailCursor = z.infer<typeof gmailCursorSchema>;
export interface GmailPageOptions {
  cursor?: GmailCursor;
  scanSince?: number;
  pageSize?: number;
  timeoutMs?: number;
}
export interface GmailPageSummary {
  matchedRemaining: number;
  scannedMessages: number;
  sourceBytes: number;
  genuineReceipts: number;
  ambiguousReceipts: number;
  unauthenticatedReceipts: number;
  otherMessages: number;
}
export interface GmailPageResult {
  receipts: PaymentReceiptReference[];
  summary: GmailPageSummary;
  nextCursor: GmailCursor | null;
}
export interface GmailImapSession {
  connect(): Promise<void>;
  mailboxOpen(
    path: string,
    options: { readOnly: true },
  ): Promise<{ path: string; uidValidity: bigint; uidNext: number }>;
  search(query: SearchObject, options: { uid: true }): Promise<number[] | false | undefined>;
  fetch(range: MessageRange, query: FetchQueryObject, options: FetchOptions): AsyncIterable<FetchMessageObject>;
  fetchOne(uid: string, query: FetchQueryObject, options: FetchOptions): Promise<FetchMessageObject | false>;
  on(event: "error", listener: (error: Error) => void): void;
  logout(): Promise<void>;
  close(): void;
}
export type GmailPageErrorCode =
  | "invalid_options"
  | "mailbox_changed"
  | "search_failed"
  | "message_unavailable"
  | "message_too_large"
  | "source_size_mismatch"
  | "page_timeout"
  | "imap_operation_failed";
export class GmailPageError extends Error {
  constructor(readonly code: GmailPageErrorCode) {
    super(`Gmail scan page failed: ${code}`);
    this.name = "GmailPageError";
  }
}
export function gmailImapOptions(
  user: string,
  password: string,
  transport?: ImapFlowOptions["transport"],
): ImapFlowOptions {
  return {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass: password.replace(/\s+/g, "") },
    logger: false,
    logRaw: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    maxLiteralSize: GMAIL_MESSAGE_BYTES + 1,
    maxLineLength: 1024 * 1024,
    maxResponseSize: GMAIL_MESSAGE_BYTES + 128 * 1024,
    maxResponseTokens: 200_000,
    transport,
  };
}
async function bounded<T>(run: () => Promise<T>, milliseconds: number, expire: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            expire();
          } catch {
            // A failed socket close must not prevent the deadline from rejecting.
          }
          reject(new GmailPageError("page_timeout"));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const missingMailbox = z.object({ serverResponseCode: z.literal("NONEXISTENT") });

async function readPage(client: GmailImapSession, options: GmailPageOptions, now: number): Promise<GmailPageResult> {
  const parsedCursor = options.cursor ? gmailCursorSchema.safeParse(options.cursor) : null;
  if (parsedCursor && !parsedCursor.success) {
    throw new GmailPageError("invalid_options");
  }
  const previous = parsedCursor?.data;
  const pageSize = options.pageSize ?? GMAIL_PAGE_SIZE;
  const scanSince = previous?.scanSince ?? options.scanSince ?? now - WINDOW_MS;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > GMAIL_PAGE_SIZE ||
    !Number.isSafeInteger(scanSince) ||
    scanSince < 0 ||
    scanSince > now ||
    (previous && options.scanSince !== undefined && options.scanSince !== previous.scanSince)
  ) {
    throw new GmailPageError("invalid_options");
  }
  await client.connect();
  let mailbox = previous?.mailbox ?? "[Gmail]/All Mail";
  let opened;
  try {
    opened = await client.mailboxOpen(mailbox, { readOnly: true });
  } catch (error) {
    // A transient/permission error must not silently narrow an existing scan to INBOX.
    if (previous || !missingMailbox.safeParse(error).success) {
      throw error;
    }
    mailbox = "INBOX";
    opened = await client.mailboxOpen(mailbox, { readOnly: true });
  }
  const cursor = gmailCursorSchema.safeParse({
    version: 1,
    scanSince,
    mailbox,
    uidValidity: opened.uidValidity.toString(),
    upperUid: previous?.upperUid ?? opened.uidNext - 1,
    afterUid: previous?.afterUid ?? 0,
  });
  if (!cursor.success || (previous && previous.uidValidity !== cursor.data.uidValidity)) {
    throw new GmailPageError("mailbox_changed");
  }
  const state = cursor.data;
  const summary: GmailPageSummary = {
    matchedRemaining: 0,
    scannedMessages: 0,
    sourceBytes: 0,
    genuineReceipts: 0,
    ambiguousReceipts: 0,
    unauthenticatedReceipts: 0,
    otherMessages: 0,
  };
  if (state.afterUid === state.upperUid) {
    return { receipts: [], summary, nextCursor: null };
  }
  // Explicit UID mode is distinct from asking FETCH to include a UID field.
  // Parser response/line limits bound SEARCH metadata even for an unusually busy mailbox.
  const found = await client.search(
    { since: new Date(scanSince), from: "venmo@venmo.com", uid: `${state.afterUid + 1}:${state.upperUid}` },
    { uid: true },
  );
  if (
    !Array.isArray(found) ||
    found.some((uid) => !Number.isSafeInteger(uid) || uid <= state.afterUid || uid > state.upperUid)
  ) {
    throw new GmailPageError("search_failed");
  }
  const uids = [...new Set(found)].sort((left, right) => left - right);
  summary.matchedRemaining = uids.length;
  if (!uids.length) {
    return { receipts: [], summary, nextCursor: null };
  }
  const selected = uids.slice(0, pageSize);
  const metadata = new Map<number, FetchMessageObject>();
  // Finish this iterator before issuing another IMAP command (ImapFlow forbids nested FETCH).
  for await (const message of client.fetch(selected, { uid: true, size: true, internalDate: true }, { uid: true })) {
    if (!selected.includes(message.uid) || metadata.has(message.uid)) {
      throw new GmailPageError("message_unavailable");
    }
    metadata.set(message.uid, message);
  }
  const receipts: PaymentReceiptReference[] = [];
  let afterUid = state.afterUid;
  for (const uid of selected) {
    const message = metadata.get(uid);
    if (
      !message ||
      !Number.isSafeInteger(message.size) ||
      message.size! <= 0 ||
      !(message.internalDate instanceof Date) ||
      !Number.isFinite(message.internalDate.getTime())
    ) {
      throw new GmailPageError("message_unavailable");
    }
    if (message.size! > GMAIL_MESSAGE_BYTES) {
      throw new GmailPageError("message_too_large");
    }
    if (summary.sourceBytes + message.size! > GMAIL_PAGE_BYTES) {
      break; // No cursor advance over the deferred message.
    }
    const body = await client.fetchOne(
      String(uid),
      // Fetch the envelope only with this bounded message, not for the whole page.
      { uid: true, envelope: true, source: { start: 0, maxLength: GMAIL_MESSAGE_BYTES + 1 } },
      { uid: true },
    );
    if (!body || body.uid !== uid || !body.source) {
      throw new GmailPageError("message_unavailable");
    }
    if (body.source.length > GMAIL_MESSAGE_BYTES) {
      throw new GmailPageError("message_too_large");
    }
    if (body.source.length !== message.size) {
      throw new GmailPageError("source_size_mismatch");
    }
    const parsed = await simpleParser(body.source, { skipHtmlToText: true, skipTextToHtml: true });
    const classification = classifyReceipt({
      receiptKey: `uid:${uid}`,
      internalDate: message.internalDate,
      subject: parsed.subject ?? body.envelope?.subject ?? "",
      fromAddresses:
        parsed.from?.value.flatMap((entry) =>
          entry.address
            ? [entry.address]
            : (entry.group ?? []).flatMap((member) => (member.address ? [member.address] : [])),
        ) ?? [],
      authenticationHeaders: parsed.headerLines
        .filter((header) => header.key.toLowerCase() === "authentication-results")
        .map((header) => header.line),
      plaintext: parsed.text,
      html: parsed.html === false ? undefined : parsed.html,
    });
    const paidId = selectSinglePaymentReference(classification.paidIds);
    if (classification.status === "genuine_single_id" && paidId && classification.internalDate) {
      receipts.push({ paidId, receivedAt: classification.internalDate });
      summary.genuineReceipts++;
    } else if (classification.status === "genuine_multiple_ids") {
      summary.ambiguousReceipts++;
    } else if (
      classification.status === "authentication_failed" ||
      classification.status === "authentication_unknown"
    ) {
      summary.unauthenticatedReceipts++;
    } else {
      summary.otherMessages++;
    }
    summary.scannedMessages++;
    summary.sourceBytes += body.source.length;
    afterUid = uid;
  }
  return { receipts, summary, nextCursor: summary.scannedMessages === uids.length ? null : { ...state, afterUid } };
}

/** Fetch-only: this module has no database or notification dependency. */
export async function fetchGmailPage(
  client: GmailImapSession,
  options: GmailPageOptions = {},
  now = Date.now(),
): Promise<GmailPageResult> {
  const timeoutMs = options.timeoutMs ?? GMAIL_PAGE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GMAIL_PAGE_TIMEOUT_MS) {
    throw new GmailPageError("invalid_options");
  }
  // Socket errors must have a listener even after connect resolves; all output remains sanitized.
  client.on("error", () => {});
  let timedOut = false;
  try {
    return await bounded(
      () => readPage(client, options, now),
      timeoutMs,
      () => {
        timedOut = true;
        client.close();
      },
    );
  } catch (error) {
    if (timedOut) {
      throw new GmailPageError("page_timeout");
    }
    throw error instanceof GmailPageError ? error : new GmailPageError("imap_operation_failed");
  } finally {
    try {
      await bounded(
        () => client.logout(),
        3_000,
        () => client.close(),
      );
    } catch {
      client.close();
    }
  }
}
