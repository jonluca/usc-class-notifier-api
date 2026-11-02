-- Apply only AFTER importing all historical WatchedSection rows.
-- Keep legacy cross-semester duplicates, but reserve every historical reference forever.
INSERT OR IGNORE INTO "PaymentReference" ("paidId") SELECT DISTINCT "paidId" FROM "WatchedSection";

CREATE TRIGGER "WatchedSection_reserve_paidId_insert"
AFTER INSERT ON "WatchedSection"
BEGIN
  INSERT INTO "PaymentReference" ("paidId") VALUES (NEW."paidId");
END;

CREATE TRIGGER "WatchedSection_reserve_paidId_update"
AFTER UPDATE OF "paidId" ON "WatchedSection"
WHEN NEW."paidId" <> OLD."paidId"
BEGIN
  INSERT INTO "PaymentReference" ("paidId") VALUES (NEW."paidId");
END;
