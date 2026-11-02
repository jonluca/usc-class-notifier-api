import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { D1Executor } from "@/server/d1/executor";
import { searchD1Sections } from "./d1ClassSearch";

test("D1 search preserves literal matching, leading zeros, long queries, Unicode and bounded results", async (context) => {
  const sqlite = new DatabaseSync(":memory:");
  context.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE ClassInfo (
    id TEXT PRIMARY KEY, department TEXT, section TEXT, courseNumber TEXT,
    courseTitle TEXT, prefix TEXT, semester TEXT, instructor TEXT, type TEXT,
    units TEXT, day TEXT, location TEXT, hasDClearance INTEGER, isCancelled INTEGER
  )`);
  const queries: string[] = [];
  // SAFETY: Search uses only query(); real SQLite executes all SQL against the catalog fixture schema.
  const d1 = {
    query: async (sql, params = []) => {
      assert.ok(params.length <= 100);
      assert.doesNotMatch(sql, /\bLIKE\b|\bGLOB\b/i);
      queries.push(sql);
      return sqlite.prepare(sql).all(...params);
    },
  } as D1Executor;
  const insert = sqlite.prepare(
    `INSERT INTO ClassInfo (id, department, section, courseNumber, courseTitle, semester, instructor, hasDClearance, isCancelled) VALUES (?, 'LAW', ?, 'LAW-532', ?, ?, ?, 1, ?)`,
  );
  insert.run("law", "03172", "100% _science " + "x".repeat(80), "20271", "ÉLODIE", 0);
  insert.run("cancelled", "03173", "100% _science", "20271", "Élodie", 1);
  insert.run("old", "03174", "100% _science", "20263", "Élodie", 0);
  for (const tokens of [["03172"], ["100%", "_science"], ["x".repeat(80)], ["élodie"]]) {
    const result = await searchD1Sections(d1, "20271", tokens);
    assert.equal(result.sections.length, 1);
    assert.equal(result.sections[0]?.section, "03172");
    assert.equal(result.sections[0]?.hasDClearance, true);
    assert.equal(result.sections[0]?.isCancelled, false);
  }
  assert.equal((await searchD1Sections(d1, "20271", ["' OR 1=1 --"])).sections.length, 0);
  for (let i = 0; i < 260; i++) {
    insert.run(`page-${i}`, String(40_000 + i), i > 205 ? "Économie" : "Other", "20271", null, 0);
  }
  queries.length = 0;
  const unicode = await searchD1Sections(d1, "20271", ["économie"]);
  assert.equal(unicode.sections.length, 50);
  assert.equal(unicode.hasMore, true);
  assert.equal(queries.length, 2);
  const ascii = await searchD1Sections(d1, "20271", ["law"]);
  assert.equal(ascii.sections.length, 50);
  assert.equal(ascii.hasMore, true);
});
