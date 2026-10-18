// Who a house group holds: long-term, verified, consented residents; at most nine, earliest move-in first;
// a short stay never joins; a changed list is a different group.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { diffMembers, memberHash, selectGroupMembers } from "@/lib/house-groups/members";
import { candidatesFromStays, firstNameOf } from "@/lib/house-groups/residents.server";
import type { ResidentCandidate } from "@/lib/house-groups/types";

function resident(n: number, over: Partial<ResidentCandidate> = {}): ResidentCandidate {
  const key = `20655510${String(n).padStart(2, "0")}`;
  return {
    phoneKey: key,
    phoneE164: `+1${key}`,
    userId: `user-${n}`,
    firstName: `Res${n}`,
    roomLabel: `Room ${n}`,
    moveIn: `2026-0${(n % 9) + 1}-01`,
    longTerm: true,
    verifiedPhone: true,
    consented: true,
    optedOut: false,
    stopped: false,
    ...over,
  };
}

describe("selectGroupMembers", () => {
  it("keeps the first nine by move-in date and moves the rest to one-on-one texts", () => {
    const candidates = Array.from({ length: 12 }, (_, i) => resident(i + 1, { moveIn: `2026-01-${String(i + 1).padStart(2, "0")}` }));
    const selection = selectGroupMembers([...candidates].reverse());
    expect(selection.members).toHaveLength(9);
    expect(selection.members.map((m) => m.firstName)).toEqual(candidates.slice(0, 9).map((c) => c.firstName));
    expect(selection.overflow.map((m) => m.firstName)).toEqual(["Res10", "Res11", "Res12"]);
    expect(selection.tooFew).toBe(false);
  });

  it("never adds a short stay, an unverified phone, a resident without consent, a leaver or a STOP", () => {
    const selection = selectGroupMembers([
      resident(1),
      resident(2),
      resident(3, { longTerm: false }),
      resident(4, { verifiedPhone: false }),
      resident(5, { consented: false }),
      resident(6, { optedOut: true }),
      resident(7, { stopped: true }),
    ]);
    expect(selection.members.map((m) => m.firstName)).toEqual(["Res1", "Res2"]);
    expect(Object.fromEntries(selection.excluded.map((e) => [e.phoneKey.slice(-2), e.reason]))).toEqual({
      "03": "short_stay",
      "04": "unverified_phone",
      "05": "no_consent",
      "06": "left_group",
      "07": "stopped",
    });
  });

  it("counts one phone once and needs two residents to make a group", () => {
    const dup = selectGroupMembers([resident(1), resident(1, { firstName: "Again" })]);
    expect(dup.members).toHaveLength(1);
    expect(dup.excluded).toEqual([{ phoneKey: resident(1).phoneKey, reason: "duplicate" }]);
    expect(dup.tooFew).toBe(true);
    expect(selectGroupMembers([]).tooFew).toBe(true);
  });
});

describe("memberHash and diffMembers", () => {
  it("defines a group by its phone list, not its order, names or rooms", () => {
    expect(memberHash(["b", "a", "c"])).toBe(memberHash(["c", "b", "a", "a"]));
    expect(memberHash(["a", "b"])).not.toBe(memberHash(["a", "b", "c"]));
  });

  it("reports who joined and who left", () => {
    expect(diffMembers(["a", "b"], ["b", "a"]).same).toBe(true);
    expect(diffMembers(["a", "b"], ["b", "c"])).toEqual({ same: false, added: ["c"], removed: ["a"] });
  });
});

describe("candidatesFromStays", () => {
  const today = "2026-10-18";
  const stay = (over: Record<string, unknown> = {}) => ({
    propertyId: "p1",
    roomLabel: "Room 2",
    start: "2026-09-01",
    end: "2027-08-31",
    resident: { source: "proplane", residentName: "Maya Chen", residentEmail: "maya@example.com", residentPhone: "2065550101" },
    ...over,
  });
  const profiles = new Map([["maya@example.com", { id: "u-maya", email: "maya@example.com", phone: "+12065550101", verified: true, fullName: "Maya Chen" }]]);
  const base = { propertyId: "p1", today, profilesByEmail: profiles, preferenceByPhoneKey: new Map(), stoppedPhoneKeys: new Set<string>() };

  it("reads a lease as a long-term, verified resident with a first name and a room", () => {
    const [c] = candidatesFromStays([stay()], base);
    expect(c).toMatchObject({ firstName: "Maya", roomLabel: "Room 2", longTerm: true, verifiedPhone: true, consented: false, phoneKey: "2065550101" });
  });

  it("treats a stay under a month as a short stay and skips a stay with no resident payload (a guest booking)", () => {
    const short = candidatesFromStays([stay({ start: "2026-10-10", end: "2026-10-25" })], base);
    expect(short[0]?.longTerm).toBe(false);
    expect(candidatesFromStays([stay({ resident: undefined })], base)).toEqual([]);
  });

  it("skips stays that do not cover today or belong to another house", () => {
    expect(candidatesFromStays([stay({ end: "2026-10-01" }), stay({ start: "2026-11-01" }), stay({ propertyId: "p2" })], base)).toEqual([]);
    expect(candidatesFromStays([stay({ end: "2026-10-18" })], base)).toHaveLength(1);
  });

  it("applies consent, leave-group and STOP state by phone", () => {
    const withPrefs = {
      ...base,
      preferenceByPhoneKey: new Map([["2065550101", { optedOut: false, consentAt: "2026-10-01T00:00:00Z" }]]),
    };
    expect(candidatesFromStays([stay()], withPrefs)[0]?.consented).toBe(true);
    const left = { ...base, preferenceByPhoneKey: new Map([["2065550101", { optedOut: true, consentAt: "2026-10-01T00:00:00Z" }]]) };
    expect(candidatesFromStays([stay()], left)[0]).toMatchObject({ consented: false, optedOut: true });
    expect(candidatesFromStays([stay()], { ...base, stoppedPhoneKeys: new Set(["2065550101"]) })[0]?.stopped).toBe(true);
  });

  it("takes a first name only", () => {
    expect(firstNameOf("Maya Chen")).toBe("Maya");
    expect(firstNameOf("  ")).toBe("");
  });
});
