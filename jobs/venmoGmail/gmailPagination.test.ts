import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestClient } from "../../src/server/d1/testing";
import { getValidSemesters } from "../../src/utils/semester";
import { GmailVenmoImapClient } from "./gmailClient";
import type { FetchMessageObject, FetchOptions, FetchQueryObject, MessageRange, SearchObject } from "imapflow";
import {
  fetchGmailPage,
  gmailImapOptions,
  GMAIL_MESSAGE_BYTES,
  GmailPageError,
  type GmailImapSession,
} from "./gmailPagination";

const now = Date.parse("2026-11-02T00:00:00Z");
export function receiptSource(paidId: string, authenticated = true, padding = "") {
  return Buffer.from(
    [
      "From: Venmo <venmo@venmo.com>",
      "To: local@test.invalid",
      "Subject: Example paid you $1.00",
      ...(authenticated
        ? ["Authentication-Results: mx.google.com; dkim=pass header.i=@venmo.com; dmarc=pass header.from=venmo.com"]
        : []),
      "Content-Type: text/plain; charset=utf-8",
      "",
      `Payment note: ${paidId}`,
      padding,
    ].join("\r\n"),
  );
}
function message(uid: number, paidId = "12345678", authenticated = true): FetchMessageObject {
  const source = receiptSource(paidId, authenticated);
  return { uid, seq: uid + 1000, size: source.length, source, internalDate: new Date(now - 1000) };
}
export class GmailFixture implements GmailImapSession {
  uidValidity = 7n;
  uidNext = 1000;
  connected = 0;
  loggedOut = 0;
  closed = 0;
  listeners = 0;
  bodyFetches: number[] = [];
  searchCalls: { query: SearchObject; options: { uid: true } }[] = [];
  fetchCalls: { range: MessageRange; query: FetchQueryObject; options: FetchOptions }[] = [];
  openFailure: Error | undefined;
  searchFailure = false;
  hangingConnect = false;
  hangingLogout = false;
  constructor(readonly messages: FetchMessageObject[]) {}
  async connect() {
    assert.equal(this.listeners, 1);
    this.connected++;
    if (this.hangingConnect) {
      await new Promise<void>(() => {});
    }
  }
  async mailboxOpen(path: string, options: { readOnly: true }) {
    assert.equal(options.readOnly, true);
    if (path === "[Gmail]/All Mail" && this.openFailure) {
      throw this.openFailure;
    }
    return { path, uidValidity: this.uidValidity, uidNext: this.uidNext };
  }
  async search(query: SearchObject, options: { uid: true }) {
    assert.equal(options.uid, true);
    this.searchCalls.push({ query, options });
    if (this.searchFailure) {
      return false;
    }
    const [first, last] = String(query.uid).split(":").map(Number);
    return this.messages
      .filter((item) => item.uid >= first! && item.uid <= last!)
      .map((item) => item.uid)
      .reverse();
  }
  async *fetch(range: MessageRange, query: FetchQueryObject, options: FetchOptions) {
    assert.equal(options.uid, true);
    assert.equal(query.source, undefined);
    assert.equal(query.size, true);
    assert.equal(query.envelope, undefined);
    assert.ok(Array.isArray(range));
    this.fetchCalls.push({ range, query, options });
    for (const item of this.messages.filter((item) => range.includes(item.uid))) {
      const { source: _source, envelope: _envelope, ...metadata } = item;
      yield metadata;
    }
  }
  async fetchOne(uid: string, query: FetchQueryObject, options: FetchOptions) {
    assert.equal(options.uid, true);
    assert.equal(query.envelope, true);
    assert.deepEqual(query.source, { start: 0, maxLength: GMAIL_MESSAGE_BYTES + 1 });
    this.bodyFetches.push(Number(uid));
    return this.messages.find((item) => item.uid === Number(uid)) ?? false;
  }
  on() {
    this.listeners++;
  }
  async logout() {
    this.loggedOut++;
    if (this.hangingLogout) {
      await new Promise<void>(() => {});
    }
  }
  close() {
    this.closed++;
  }
}

test("UID pages pin window/high-water mark, exclude new arrivals and survive sequence renumbering", async () => {
  const first = new GmailFixture([message(101), message(305, "87654321"), message(799, "23456789")]);
  const page = await fetchGmailPage(first, { pageSize: 2 }, now);
  assert.equal(page.receipts.length, 2);
  assert.equal(page.summary.scannedMessages, 2);
  assert.equal(page.nextCursor?.afterUid, 305);
  assert.equal(page.nextCursor?.upperUid, 999);
  assert.equal(page.nextCursor?.scanSince, now - 30 * 24 * 60 * 60 * 1000);
  const second = new GmailFixture([message(799, "23456789"), message(1200, "34567890")]);
  second.uidNext = 1201;
  const next = await fetchGmailPage(second, { cursor: page.nextCursor!, pageSize: 2 }, now + 60_000);
  assert.deepEqual(second.bodyFetches, [799]);
  assert.deepEqual(second.searchCalls[0]?.query.since, first.searchCalls[0]?.query.since);
  assert.equal(next.nextCursor, null);
  assert.equal(first.loggedOut, 1);
  assert.equal(second.loggedOut, 1);
});

test("real MIME parsing retains receipt authentication and amount/reference rules", async () => {
  const client = new GmailFixture([
    message(11),
    message(12, "87654321", false),
    message(13, "12345678\r\nMemo: 23456789"),
  ]);
  const page = await fetchGmailPage(client, {}, now);
  assert.deepEqual(
    page.receipts.map((receipt) => receipt.paidId),
    ["12345678"],
  );
  assert.equal(page.summary.genuineReceipts, 1);
  assert.equal(page.summary.unauthenticatedReceipts, 1);
  assert.equal(page.summary.ambiguousReceipts, 1);
  assert.equal(page.receipts[0]?.receivedAt.getTime(), now - 1000);
});

test("page metadata excludes envelopes while each bounded body retains the Subject fallback", async () => {
  const source = Buffer.from(receiptSource("12345678").toString().replace("Subject: Example paid you $1.00\r\n", ""));
  const item = {
    ...message(11),
    size: source.length,
    source,
    envelope: { subject: "Example paid you $1.00" },
  };
  const client = new GmailFixture([item]);
  const page = await fetchGmailPage(client, {}, now);
  assert.equal(client.fetchCalls[0]?.query.envelope, undefined);
  assert.equal(page.summary.genuineReceipts, 1);
  assert.deepEqual(
    page.receipts.map((receipt) => receipt.paidId),
    ["12345678"],
  );
});

test("UIDVALIDITY changes and rejected searches fail without returning an advanced cursor", async () => {
  const page = await fetchGmailPage(new GmailFixture([message(11), message(12)]), { pageSize: 1 }, now);
  const changed = new GmailFixture([message(12)]);
  changed.uidValidity = 8n;
  await assert.rejects(
    fetchGmailPage(changed, { cursor: page.nextCursor! }, now),
    (error) => error instanceof GmailPageError && error.code === "mailbox_changed",
  );
  assert.equal(changed.bodyFetches.length, 0);
  const rejected = new GmailFixture([]);
  rejected.searchFailure = true;
  await assert.rejects(
    fetchGmailPage(rejected, {}, now),
    (error) => error instanceof GmailPageError && error.code === "search_failed",
  );
});

test("only a nonexistent All Mail mailbox allows the explicit INBOX fallback", async () => {
  const transient = new GmailFixture([]);
  transient.openFailure = Error("temporary network failure");
  await assert.rejects(fetchGmailPage(transient, {}, now), /imap_operation_failed/);
  const absent = new GmailFixture([message(11), message(12)]);
  absent.openFailure = Object.assign(Error("mailbox absent"), { serverResponseCode: "NONEXISTENT" });
  const page = await fetchGmailPage(absent, { pageSize: 1 }, now);
  assert.equal(page.nextCursor?.mailbox, "INBOX");
});

test("oversized or truncated messages fail before cursor advancement; oversized metadata prevents body download", async () => {
  const oversized = message(11);
  oversized.size = GMAIL_MESSAGE_BYTES + 1;
  const client = new GmailFixture([oversized]);
  await assert.rejects(fetchGmailPage(client, {}, now), /message_too_large/);
  assert.equal(client.bodyFetches.length, 0);
  const truncated = message(12);
  truncated.size = truncated.size! + 1;
  await assert.rejects(fetchGmailPage(new GmailFixture([truncated]), {}, now), /source_size_mismatch/);
});

test("page byte budget returns a continuation without dropping the deferred message", async () => {
  const messages = [11, 12, 13].map((uid) => {
    const source = receiptSource("12345678", true, "x".repeat(3 * 1024 * 1024));
    return { ...message(uid), size: source.length, source };
  });
  const client = new GmailFixture(messages);
  const page = await fetchGmailPage(client, {}, now);
  assert.equal(page.summary.scannedMessages, 2);
  assert.equal(page.nextCursor?.afterUid, 12);
  assert.deepEqual(client.bodyFetches, [11, 12]);
  const last = await fetchGmailPage(new GmailFixture(messages), { cursor: page.nextCursor! }, now);
  assert.equal(last.summary.scannedMessages, 1);
  assert.equal(last.nextCursor, null);
});

test("page deadline closes a stalled session and cleanup is bounded", async () => {
  const client = new GmailFixture([]);
  client.hangingConnect = true;
  const start = performance.now();
  await assert.rejects(fetchGmailPage(client, { timeoutMs: 10 }, now), /page_timeout/);
  assert.ok(performance.now() - start < 1000);
  assert.ok(client.closed > 0);
  assert.equal(client.loggedOut, 1);
  const cleanup = new GmailFixture([]);
  cleanup.hangingLogout = true;
  const cleanupStart = performance.now();
  await fetchGmailPage(cleanup, {}, now);
  assert.ok(performance.now() - cleanupStart < 4000);
  assert.ok(cleanup.closed > 0);
});

test("connection and parser limits are explicit and automatic IDLE is disabled", () => {
  const options = gmailImapOptions("local@test.invalid", "a b c d");
  assert.equal(options.disableAutoIdle, true);
  assert.equal(options.connectionTimeout, 15_000);
  assert.equal(options.greetingTimeout, 10_000);
  assert.equal(options.socketTimeout, 20_000);
  assert.equal(options.maxLiteralSize, GMAIL_MESSAGE_BYTES + 1);
  assert.equal(options.logRaw, false);
  assert.equal(options.auth?.pass, "abcd");
});

test("fetch-only pages never mark payments; checked pages preserve date guards and idempotent D1 writes", async (context) => {
  const fixture = await createD1TestClient({ installGuards: false });
  context.after(() => fixture.dispose());
  const originalUser = process.env.GMAIL_IMAP_USER;
  const originalPassword = process.env.GMAIL_IMAP_APP_PASSWORD;
  process.env.GMAIL_IMAP_USER = "local@test.invalid";
  process.env.GMAIL_IMAP_APP_PASSWORD = "synthetic-password";
  context.after(() => {
    if (originalUser === undefined) {
      delete process.env.GMAIL_IMAP_USER;
    } else {
      process.env.GMAIL_IMAP_USER = originalUser;
    }
    if (originalPassword === undefined) {
      delete process.env.GMAIL_IMAP_APP_PASSWORD;
    } else {
      process.env.GMAIL_IMAP_APP_PASSWORD = originalPassword;
    }
  });
  const semester = getValidSemesters()[0]!;
  await fixture.executor.batch([
    {
      sql: "INSERT INTO Student(id,email,verificationKey) VALUES (?,?,?)",
      params: ["student", "local@test.invalid", "local-key"],
    },
    {
      sql: "INSERT INTO WatchedSection(id,createdAt,section,semester,paidId,studentId) VALUES (?,?,?,?,?,?)",
      params: ["watch", now - 24 * 60 * 60 * 1000, "03173", semester, "12345678", "student"],
    },
  ]);
  await fixture.executor.batch([
    {
      sql: "INSERT INTO WatchedSection(id,createdAt,section,semester,paidId,studentId) VALUES (?,?,?,?,?,?)",
      params: ["ambiguous-current", now - 24 * 60 * 60 * 1000, "03174", semester, "87654321", "student"],
    },
    {
      sql: "INSERT INTO WatchedSection(id,createdAt,section,semester,paidId,studentId) VALUES (?,?,?,?,?,?)",
      params: ["ambiguous-historical", now - 24 * 60 * 60 * 1000, "03174", "19991", "87654321", "student"],
    },
  ]);
  await fixture.installGuards();
  const oldReceipt = { ...message(11), internalDate: new Date(now - 3 * 24 * 60 * 60 * 1000) };
  const currentReceipt = message(12);
  const client = new GmailVenmoImapClient({
    database: fixture.database,
    now: () => now,
    createImapClient: () => new GmailFixture([oldReceipt, currentReceipt, message(13, "87654321")]),
  });
  const before = await client.fetchPage();
  assert.equal(before.receipts.length, 3);
  assert.equal(await fixture.database.watchedSection.count({ where: { isPaid: true } }), 0);
  const first = await client.checkPage({ pageSize: 1 });
  assert.equal(first.summary.updatedCount, 0);
  assert.equal(await fixture.database.watchedSection.count({ where: { isPaid: true } }), 0);
  const next = await client.checkPage({ cursor: first.nextCursor!, pageSize: 1 });
  assert.equal(next.summary.updatedCount, 1);
  assert.ok(next.nextCursor);
  const ambiguous = await client.checkPage({ cursor: next.nextCursor, pageSize: 1 });
  assert.equal(ambiguous.summary.updatedCount, 0);
  assert.equal(ambiguous.nextCursor, null);
  assert.equal((await client.checkPage()).summary.updatedCount, 0);
  assert.equal(await fixture.database.watchedSection.count({ where: { isPaid: true, paidNotified: false } }), 1);
  await fixture.database.watchedSection.updateMany({ where: { id: "watch" }, data: { isPaid: false } });
  let connections = 0;
  const many = new GmailVenmoImapClient({
    database: fixture.database,
    now: () => now,
    createImapClient: () => {
      connections++;
      return new GmailFixture(Array.from({ length: 101 }, (_value, index) => message(index + 1)));
    },
  });
  await many.checkEmails();
  assert.equal(connections, 2);
  assert.equal(await fixture.database.watchedSection.count({ where: { isPaid: true } }), 1);
});
