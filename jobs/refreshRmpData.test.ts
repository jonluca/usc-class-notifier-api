import assert from "node:assert/strict";
import test from "node:test";
import { mergeProfessorRatings } from "./refreshRmpData";

test("rating refresh matches compact records by legacy ID and retains unreturned professors", () => {
  const retained = { avgRating: 4, firstName: "Alex", lastName: "Lee", legacyId: 10 };
  const existing = { avgRating: 3, firstName: "Alex", lastName: "Lee", legacyId: 20 };
  const updated = { ...existing, avgRating: 4.5, firstName: "Alexandra" };
  const added = { avgRating: 5, firstName: "Sam", lastName: "Ng", legacyId: 30 };

  const merged = mergeProfessorRatings([existing, retained], [added, updated]);
  assert.deepEqual(merged, [retained, updated, added]);
  assert.deepEqual(
    mergeProfessorRatings(merged, [updated, added]),
    merged,
    "repeated refreshes do not duplicate ratings",
  );
  assert.deepEqual(existing, { avgRating: 3, firstName: "Alex", lastName: "Lee", legacyId: 20 });
});

test("refresh drops unused upstream fields from new and retained legacy records", () => {
  const retained = {
    avgRating: 4,
    firstName: "Alex",
    lastName: "Lee",
    legacyId: 10,
    id: "old-graphql-id",
    school: { name: "USC" },
  };
  const added = {
    avgRating: 5,
    firstName: "Sam",
    lastName: "Ng",
    legacyId: 20,
    id: "new-graphql-id",
    avgDifficulty: 3,
    numRatings: 25,
  };
  assert.deepEqual(mergeProfessorRatings([retained], [added]), [
    { avgRating: 4, firstName: "Alex", lastName: "Lee", legacyId: 10 },
    { avgRating: 5, firstName: "Sam", lastName: "Ng", legacyId: 20 },
  ]);
});
