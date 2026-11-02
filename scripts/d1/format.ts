import { z } from "zod";
import { createHash } from "node:crypto";

export type Cell = string | number | null;
const stringSchema = z.string();
const numberSchema = z.number();
const integerInputSchema = z
  .union([numberSchema, stringSchema.regex(/^-?\d+(?:\.0+)?$/).transform(Number)])
  .pipe(numberSchema.int().safe());
export const rawRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type RawRow = z.infer<typeof rawRowSchema>;
type Kind = "text" | "integer" | "boolean" | "timestamp";
export interface Column {
  name: string;
  kind: Kind;
  nullable?: boolean;
}
const text = (name: string, nullable = false): Column => ({ name, kind: "text", nullable });
const timestamp = (name: string): Column => ({ name, kind: "timestamp", nullable: true });
const integer = (name: string, nullable = false): Column => ({ name, kind: "integer", nullable });
const boolean = (name: string): Column => ({ name, kind: "boolean" });
const common = [text("id"), timestamp("createdAt"), timestamp("updatedAt")];
export const TABLES = {
  Student: [
    ...common,
    text("email"),
    text("verificationKey"),
    text("phone", true),
    boolean("validAccount"),
    text("uscID", true),
  ],
  ClassInfo: [
    ...common,
    text("department"),
    text("section"),
    text("courseNumber"),
    text("courseTitle"),
    text("semester"),
    text("instructor", true),
    text("type", true),
    text("prefix", true),
    text("units", true),
    text("day", true),
    text("session", true),
    text("location", true),
    boolean("isDistanceLearning"),
    boolean("hasDClearance"),
    boolean("isCancelled"),
  ],
  WatchedSection: [
    ...common,
    text("section"),
    text("semester"),
    timestamp("lastNotified"),
    boolean("notified"),
    timestamp("cancelledAt"),
    integer("notificationCycle"),
    integer("emailSentCycle", true),
    integer("smsSentCycle", true),
    text("notificationClaimToken", true),
    timestamp("notificationClaimUntil"),
    text("paidId"),
    boolean("isPaid"),
    boolean("paidNotified"),
    text("phoneOverride", true),
    text("studentId"),
    text("classInfoId", true),
  ],
  NotificationSent: [...common, text("sectionId"), text("studentId")],
  PaymentReference: [text("paidId")],
} satisfies Record<string, Column[]>;
export type Table = keyof typeof TABLES;
export const APP_TABLES: Table[] = ["Student", "ClassInfo", "WatchedSection", "NotificationSent"];
export const ALL_TABLES: Table[] = [...APP_TABLES, "PaymentReference"];
export const MAX_SQL_BYTES = 64_000; // Below D1's 100,000-byte SQL limit.
export const MAX_VALUES = 100; // Also safe if statements later use D1 parameters.
export const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export const keyColumn = (table: Table): string => (table === "PaymentReference" ? "paidId" : "id");

export function normalizeRow(table: Table, row: RawRow): Cell[] {
  return TABLES[table].map((column: Column) => {
    const value = row[column.name];
    const failure = () => new Error(`Invalid ${column.kind} at ${table}.${column.name}; value withheld`);
    if (value === null && column.nullable) {
      return null;
    }
    if (column.kind === "text") {
      const parsed = stringSchema.safeParse(value);
      if (!parsed.success || parsed.data.includes("\0")) {
        throw failure();
      }
      if (Buffer.from(parsed.data, "utf8").toString("utf8") !== parsed.data) {
        throw failure();
      }
      return parsed.data;
    }
    if (column.kind === "boolean") {
      if (value === true || value === 1) {
        return 1;
      }
      if (value === false || value === 0) {
        return 0;
      }
      throw failure();
    }
    const numeric = integerInputSchema.safeParse(value);
    if (!numeric.success) {
      throw failure();
    }
    if (column.kind === "timestamp" && Math.abs(numeric.data) > 8_640_000_000_000_000) {
      throw failure();
    }
    return numeric.data;
  });
}

export function sqlValue(value: Cell): string {
  if (value === null) {
    return "NULL";
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Cell is already normalized; narrow its scalar union to select SQL encoding.
  if (typeof value === "number") {
    return String(value);
  }
  // Hex-encoded UTF-8 preserves apostrophes/newlines/leading zeros and keeps one statement per line.
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}
export function insertStatement(table: Table, rows: Cell[][]): string {
  const sql = `INSERT INTO ${quote(table)} (${TABLES[table].map((c) => quote(c.name)).join(",")}) VALUES ${rows.map((r) => `(${r.map(sqlValue).join(",")})`).join(",")};\n`;
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES || rows.length * TABLES[table].length > MAX_VALUES) {
    throw new Error(`D1 statement bound exceeded for ${table}; contents withheld`);
  }
  return sql;
}
export interface TableSummary {
  rows: number;
  sha256: string;
  leadingZeroTextValues: number;
  timestamps: Record<string, { nonNull: number; min: number | null; max: number | null }>;
}
export class TableDigest {
  private hash = createHash("sha256");
  private previous?: Buffer;
  private count = 0;
  private leadingZeros = 0;
  private timestamps: TableSummary["timestamps"] = {};
  constructor(private table: Table) {
    for (const c of TABLES[table]) {
      if (c.kind === "timestamp") {
        this.timestamps[c.name] = { nonNull: 0, min: null, max: null };
      }
    }
  }
  add(row: Cell[]): void {
    const key = row[TABLES[this.table].findIndex((c) => c.name === keyColumn(this.table))];
    const parsedKey = stringSchema.safeParse(key);
    if (!parsedKey.success) {
      throw new Error(`Missing key for ${this.table}`);
    }
    const bytes = Buffer.from(parsedKey.data, "utf8");
    if (this.previous && Buffer.compare(this.previous, bytes) >= 0) {
      throw new Error(`Non-unique or unordered key in ${this.table}; key withheld`);
    }
    this.previous = bytes;
    this.hash.update(JSON.stringify(row) + "\n");
    this.count++;
    row.forEach((v, i) => {
      const column = TABLES[this.table][i]!;
      if (v !== null && column.kind === "text" && /^0\d+$/.test(stringSchema.parse(v))) {
        this.leadingZeros++;
      }
      const stats = this.timestamps[column.name];
      if (stats && v !== null) {
        const numeric = numberSchema.parse(v);
        stats.nonNull++;
        stats.min = stats.min === null ? numeric : Math.min(stats.min, numeric);
        stats.max = stats.max === null ? numeric : Math.max(stats.max, numeric);
      }
    });
  }
  finish(): TableSummary {
    return {
      rows: this.count,
      sha256: this.hash.digest("hex"),
      leadingZeroTextValues: this.leadingZeros,
      timestamps: this.timestamps,
    };
  }
}
