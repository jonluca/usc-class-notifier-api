// Data only: USC building code -> full name, for LOCATION expansion. ~225 entries, cross-
// referenced against multiple current USC sources (e.g. THH -> "Mark Taper Hall of Humanities",
// KAP -> "Kaprielian Hall"). A raw code is legal inside an ICS LOCATION: field on its own, so a
// missing/wrong entry is polish, never a blocker — see courseBinScrape.ts's expandLocation,
// which falls back to the raw code on any miss.

import buildingNames from "@/data/buildingNames.json" with { type: "json" };

export const USC_BUILDINGS = new Map<string, string>(Object.entries(buildingNames));
