/**
 * Portfolio import — `applyAnswersAndSkips` (store.server.ts), the pure merge
 * PATCH and create-time both run. Covers the server-side room skip: an empty
 * room (no resident tied to it) the manager marks "Skip" on the review
 * screen is dropped from `property.rooms` so `create.server.ts` never
 * creates it as an unoccupied room — see docs/agents/portfolio-import.md and
 * review-step.tsx's `EmptyRoomRow`.
 */
import { describe, expect, it } from "vitest";
import { applyAnswersAndSkips } from "@/lib/portfolio-import/store.server";
import type { ImportPropertyProposal, PortfolioImportProposal } from "@/lib/portfolio-import/types";

const SOURCE = { file: "roll.csv", sheet: "Sheet1", rows: [2] };

function property(overrides: Partial<ImportPropertyProposal> = {}): ImportPropertyProposal {
  return {
    key: "p1",
    address: "400 Pike St",
    source: SOURCE,
    rooms: [
      { key: "p1:room:0", name: "Room 1", rent: 1200, source: SOURCE },
      { key: "p1:room:1", name: "Room 2", rent: 1100, source: SOURCE },
      { key: "p1:room:2", name: "Room 5", rent: null, source: SOURCE },
    ],
    residents: [
      {
        key: "p1:resident:0",
        roomKey: "p1:room:0",
        name: "Riko Tanaka",
        email: "riko@example.com",
        phone: null,
        leaseStart: "2026-01-01",
        leaseEnd: "2026-12-31",
        rent: 1200,
        deposit: 1200,
        balance: null,
        status: "ready",
        gaps: [],
        source: SOURCE,
      },
      {
        key: "p1:resident:1",
        roomKey: "p1:room:1",
        name: "Jae Park",
        email: "jae@example.com",
        phone: null,
        leaseStart: "2026-01-01",
        leaseEnd: "2026-12-31",
        rent: 1100,
        deposit: 1100,
        balance: null,
        status: "ready",
        gaps: [],
        source: SOURCE,
      },
    ],
    charges: [],
    tasks: [],
    status: "ready",
    ...overrides,
  };
}

function proposal(properties: ImportPropertyProposal[]): PortfolioImportProposal {
  return {
    importId: "imp-1",
    files: [{ name: "roll.csv", kind: "spreadsheet" }],
    properties,
    summary: { properties: properties.length, rooms: 0, residents: 0, charges: 0, tasks: 0, gaps: 0 },
  };
}

describe("applyAnswersAndSkips — room skip", () => {
  it("drops an empty room named in skips from property.rooms", () => {
    const result = applyAnswersAndSkips(proposal([property()]), { skips: ["p1:room:2"] });
    const roomKeys = result.properties[0]!.rooms.map((r) => r.key);
    expect(roomKeys).toEqual(["p1:room:0", "p1:room:1"]);
    expect(result.properties[0]!.rooms).toHaveLength(2);
  });

  it("recomputes the summary's room count to exclude the skipped empty room", () => {
    const result = applyAnswersAndSkips(proposal([property()]), { skips: ["p1:room:2"] });
    expect(result.summary.rooms).toBe(2);
  });

  it("leaves every resident's room untouched by a room skip", () => {
    const result = applyAnswersAndSkips(proposal([property()]), { skips: ["p1:room:2"] });
    expect(result.properties[0]!.residents.map((r) => r.roomKey)).toEqual(["p1:room:0", "p1:room:1"]);
    expect(result.properties[0]!.residents.every((r) => r.status !== "skip")).toBe(true);
  });

  it("never drops a room a resident actually lives in, even if its key is passed in skips", () => {
    // Defensive: the review screen only ever offers Skip on a genuinely
    // empty room, but the server does not trust that — a room with a
    // resident tied to it survives even a (malformed or malicious) skip.
    const result = applyAnswersAndSkips(proposal([property()]), { skips: ["p1:room:0"] });
    const roomKeys = result.properties[0]!.rooms.map((r) => r.key);
    expect(roomKeys).toContain("p1:room:0");
    expect(result.properties[0]!.rooms).toHaveLength(3);
  });

  it("a repeated skip of the same already-dropped room key is a no-op, not an error", () => {
    const once = applyAnswersAndSkips(proposal([property()]), { skips: ["p1:room:2"] });
    const twice = applyAnswersAndSkips(once, { skips: ["p1:room:2"] });
    expect(twice.properties[0]!.rooms.map((r) => r.key)).toEqual(["p1:room:0", "p1:room:1"]);
  });

  it("still supports skipping a property or a resident by key (unchanged existing behavior)", () => {
    const skippedProperty = applyAnswersAndSkips(proposal([property()]), { skips: ["p1"] });
    expect(skippedProperty.properties[0]!.status).toBe("skip");
    expect(skippedProperty.summary.properties).toBe(0);

    const skippedResident = applyAnswersAndSkips(proposal([property()]), { skips: ["p1:resident:1"] });
    expect(skippedResident.properties[0]!.residents.find((r) => r.key === "p1:resident:1")!.status).toBe("skip");
    // A skipped resident's OWN room is not auto-dropped by a resident skip —
    // only an explicit room-key skip removes a room.
    expect(skippedResident.properties[0]!.rooms.map((r) => r.key)).toEqual(["p1:room:0", "p1:room:1", "p1:room:2"]);
  });
});
