import { describe, expect, it } from "vitest";
import { resolveTarget, type CatalogProperty } from "@/lib/manager-sms-commands/resolve-target";

const room = (n: number) => ({ id: `r${n}`, name: `Room ${n}`, rentUsd: 900 });
const house = (id: string, label: string, rooms: number, extra: Partial<CatalogProperty> = {}): CatalogProperty => ({
  id, workspaceId: "ws-1", ownerUserId: "owner-1", status: "live", label, title: label, rooms: Array.from({ length: rooms }, (_, i) => room(i + 1)), ...extra,
});

// Production-like: the ids are misnamed on purpose, so a match on id text would pick the wrong house.
const CATALOG = [
  house("mgr-4709a-8th-ave-7mdlyj", "4709A 8th Ave", 9),
  house("mgr-5259-brooklyn-7mbwr", "5259 Brooklyn Ave NE", 4),
  house("mgr-5257-brooklyn-1x3tiu", "5257 Brooklyn Ave NE", 4),
];

describe("target resolution", () => {
  it("resolves a house and a room from a street number and a room token", () => {
    const resolved = resolveTarget("room 4 at 5259", CATALOG, "rent");
    expect(resolved).toMatchObject({ kind: "resolved", property: { label: "5259 Brooklyn Ave NE" }, room: { name: "Room 4" } });
    expect(resolveTarget("5259 r4", CATALOG, "rent")).toMatchObject({ kind: "resolved", room: { name: "Room 4" } });
  });

  it("never guesses between the two Brooklyn houses", () => {
    const resolved = resolveTarget("brooklyn room 4", CATALOG, "rent");
    expect(resolved.kind).toBe("ask");
    if (resolved.kind === "ask") {
      expect(resolved.question).toBe("Which one: 5257 Brooklyn Ave NE or 5259 Brooklyn Ave NE?");
      expect(resolved.question.split("\n")).toHaveLength(1);
    }
  });

  it("asks which house when the text names none and there are several", () => {
    const resolved = resolveTarget("", CATALOG, "rent");
    expect(resolved).toMatchObject({ kind: "ask", question: "Which one: 4709A 8th Ave, 5257 Brooklyn Ave NE or 5259 Brooklyn Ave NE?" });
  });

  it("asks which room when a house has several and none is named", () => {
    const resolved = resolveTarget("5259", CATALOG, "rent");
    expect(resolved).toMatchObject({ kind: "ask", reason: "room" });
    // a description may be the house's own
    expect(resolveTarget("5259", CATALOG, "description")).toMatchObject({ kind: "resolved", room: null });
  });

  it("matches 4709 to 4709A, and says so when a room does not exist", () => {
    expect(resolveTarget("4709 room 9", CATALOG, "rent")).toMatchObject({ kind: "resolved", property: { label: "4709A 8th Ave" }, room: { name: "Room 9" } });
    const none = resolveTarget("5259 room 7", CATALOG, "rent");
    expect(none).toMatchObject({ kind: "ask", reason: "room" });
    if (none.kind === "ask") expect(none.question).toContain("has no Room 7");
  });

  it("uses a room named in the text to pick the one house that has it", () => {
    expect(resolveTarget("room 9", CATALOG, "rent")).toMatchObject({ kind: "resolved", property: { label: "4709A 8th Ave" } });
  });

  it("does not fall back to all houses when the number matches none", () => {
    const resolved = resolveTarget("9999 room 1", CATALOG, "rent");
    expect(resolved).toMatchObject({ kind: "ask", reason: "no_match" });
  });

  it("a single house needs no question", () => {
    expect(resolveTarget("room 2", [house("x", "12 Oak St", 3)], "rent")).toMatchObject({ kind: "resolved", room: { name: "Room 2" } });
    expect(resolveTarget("", [house("x", "12 Oak St", 1)], "rent")).toMatchObject({ kind: "resolved", room: { name: "Room 1" } });
  });

  it("matches on the address, never on the record id", () => {
    const decoy = [house("mgr-5259-brooklyn", "4709A 8th Ave", 1), house("other", "5259 Brooklyn Ave NE", 1)];
    expect(resolveTarget("5259", decoy, "description")).toMatchObject({ kind: "resolved", property: { id: "other" } });
  });
});
