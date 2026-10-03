// A lease in a shared room names the bed and its rent, says whether it is one joint lease or one per
// resident, and carries the roommate clauses; the same clauses feed the PDF's addendum.
import { describe, expect, it } from "vitest";
import {
  SHARED_ROOM_CLAUSES_MARKER,
  sharedRoomClauses,
  sharedRoomClausesHtml,
  sharedRoomLeaseTerms,
  withSharedRoomClauses,
} from "@/lib/lease-shared-room-terms";
import { bedLabelForSlot } from "@/lib/shared-room-display";

const room = (over: Record<string, unknown> = {}) =>
  ({ id: "r8", name: "Room 8", monthlyRent: 700, occupancyCapacity: 2, ...over }) as never;

describe("sharedRoomLeaseTerms", () => {
  it("is null for a single-resident room, no room, or no residents", () => {
    expect(sharedRoomLeaseTerms({ room: room({ occupancyCapacity: 1 }), propertyAddress: "1 Main", residents: [{ name: "A", slot: 1 }] })).toBeNull();
    expect(sharedRoomLeaseTerms({ room: null, propertyAddress: "1 Main", residents: [{ name: "A", slot: 1 }] })).toBeNull();
    expect(sharedRoomLeaseTerms({ room: room(), propertyAddress: "1 Main", residents: [] })).toBeNull();
  });

  it("names the bed by its slot and keeps one resident on a separate lease", () => {
    const t = sharedRoomLeaseTerms({
      room: room({ sharedRoomLeaseKind: "individual" }),
      propertyAddress: "1 Main St",
      residents: [{ name: "Casey Morgan", slot: 2 }, { name: "Dana Lee", slot: 1 }],
    })!;
    expect(t.joint).toBe(false);
    expect(t.residents).toHaveLength(1);
    expect(t.residents[0]!.bedLabel).toBe(bedLabelForSlot(2));
    expect(sharedRoomClauses(t).map((c) => c.id)).toEqual(["space", "rent", "separate", "shared", "leaves"]);
  });

  it("lists every roommate on a joint lease and uses a negotiated rent over the listed one", () => {
    const t = sharedRoomLeaseTerms({
      room: room({ sharedRoomLeaseKind: "joint" }),
      propertyAddress: "1 Main St",
      residents: [{ name: "Casey", slot: 1, rentOverride: 650 }, { name: "Dana", slot: 2 }],
    })!;
    expect(t.joint).toBe(true);
    expect(t.residents.map((r) => r.name)).toEqual(["Casey", "Dana"]);
    expect(t.residents[0]!.rentLabel).toContain("650");
    expect(t.residents[1]!.rentLabel).toContain("700");
    const ids = sharedRoomClauses(t).map((c) => c.id);
    expect(ids).toContain("roommates");
    expect(ids).not.toContain("separate");
  });

  it("a joint room with one resident is not a joint lease", () => {
    const t = sharedRoomLeaseTerms({ room: room({ sharedRoomLeaseKind: "joint" }), propertyAddress: "", residents: [{ name: "A", slot: 1 }] })!;
    expect(t.joint).toBe(false);
  });
});

describe("withSharedRoomClauses", () => {
  const terms = sharedRoomLeaseTerms({ room: room(), propertyAddress: "1 Main St", residents: [{ name: "A", slot: 1 }] })!;

  it("puts the clauses before the closing body tag, once", () => {
    const once = withSharedRoomClauses("<html><body><p>Lease</p></body></html>", terms);
    expect(once).toContain(SHARED_ROOM_CLAUSES_MARKER);
    expect(once.indexOf(SHARED_ROOM_CLAUSES_MARKER)).toBeLessThan(once.indexOf("</body>"));
    expect(withSharedRoomClauses(once, terms)).toBe(once);
  });

  it("appends to a fragment and leaves a lease with no shared room untouched", () => {
    expect(withSharedRoomClauses("<p>x</p>", terms)).toContain(sharedRoomClausesHtml(terms));
    expect(withSharedRoomClauses("<p>x</p>", null)).toBe("<p>x</p>");
  });

  it("escapes names", () => {
    const t = sharedRoomLeaseTerms({ room: room(), propertyAddress: "", residents: [{ name: "<b>Bad</b>", slot: 1 }] })!;
    expect(sharedRoomClausesHtml({ ...t, joint: true })).not.toContain("<b>Bad</b>");
  });
});
