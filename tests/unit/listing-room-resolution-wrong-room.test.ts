/**
 * A lease must never quote a DIFFERENT room's money.
 *
 * Reported as "the lease has random charges": a resident placed in one room saw a rent, deposit,
 * utilities estimate and move-in fee they did not recognise. `resolveSubmissionRoom` is the single
 * decision behind those figures — `resolveStayPricing` and the lease template both price whatever
 * room it returns — and it walks a cascade of increasingly loose fallbacks when the room id does
 * not match. Two of them can silently return the WRONG room rather than no room:
 *
 *   - the label match falls back to a SUBSTRING compare, so "Room 1" matches "Room 10";
 *   - a substring compare that matches several rooms takes whichever the array happened to list
 *     first, so the answer depends on room ordering.
 *
 * Returning `undefined` is the safe failure here. The document then prints "—" for every figure,
 * which reads as "not set" and gets fixed, instead of a confident number belonging to someone
 * else's room.
 */
import { describe, expect, it } from "vitest";
import { resolveSubmissionRoom } from "@/lib/listing-room-resolution";
import type { ManagerListingSubmissionV1, ManagerRoomSubmission } from "@/lib/manager-listing-submission";

function room(over: Partial<ManagerRoomSubmission> & { id: string; name: string }): ManagerRoomSubmission {
  return {
    id: over.id,
    name: over.name,
    monthlyRent: over.monthlyRent ?? 0,
    securityDeposit: over.securityDeposit ?? "",
    moveInFee: over.moveInFee ?? "",
    utilitiesEstimate: over.utilitiesEstimate ?? "",
    ...over,
  } as ManagerRoomSubmission;
}

function submission(rooms: ManagerRoomSubmission[]): ManagerListingSubmissionV1 {
  return {
    v: 1,
    rooms,
    bathrooms: [],
    sharedSpaces: [],
    bundles: [],
    quickFacts: [],
  } as unknown as ManagerListingSubmissionV1;
}

describe("resolveSubmissionRoom never substitutes another room's money", () => {
  it('does not let "Room 1" match "Room 10"', () => {
    // The exact-name pass misses (there is no room literally named "Room 1"), so the substring
    // pass runs — and "room 10".includes("room 1") is true.
    const sub = submission([
      room({ id: "r10", name: "Room 10", monthlyRent: 2400, securityDeposit: "2400" }),
      room({ id: "r11", name: "Room 11", monthlyRent: 2500, securityDeposit: "2500" }),
    ]);

    const picked = resolveSubmissionRoom(sub, { unitLabel: "Room 1" });

    expect(picked?.name).not.toBe("Room 10");
    expect(picked).toBeUndefined();
  });

  it("refuses an ambiguous substring match instead of taking the first listed", () => {
    // "Room 2" is a substring of both. Whichever is returned is decided by array order, which is
    // not a fact about this resident's placement.
    const sub = submission([
      room({ id: "a", name: "Room 20", monthlyRent: 1000 }),
      room({ id: "b", name: "Room 21", monthlyRent: 1900 }),
    ]);

    expect(resolveSubmissionRoom(sub, { unitLabel: "Room 2" })).toBeUndefined();
  });

  it("does not hand back the only room when the applicant chose a different one", () => {
    // A single-room listing plus a room choice that names something else means the catalog and
    // the application disagree. Pricing the one room anyway is how a stale local catalog quotes
    // figures for a room the resident was never placed in.
    const sub = submission([room({ id: "only-room", name: "Room 6", monthlyRent: 800 })]);

    const picked = resolveSubmissionRoom(sub, { roomChoices: ["prop-1::some-other-room"] });

    expect(picked).toBeUndefined();
  });

  it("still resolves the room the applicant actually chose", () => {
    const sub = submission([
      room({ id: "seed-room-1", name: "Room 1", monthlyRent: 800 }),
      room({ id: "seed-room-6", name: "Room 6", monthlyRent: 950 }),
    ]);

    const picked = resolveSubmissionRoom(sub, { roomChoices: ["mgr-seed::seed-room-6"] });

    expect(picked?.id).toBe("seed-room-6");
    expect(picked?.monthlyRent).toBe(950);
  });

  it("still resolves an exact label match", () => {
    const sub = submission([
      room({ id: "a", name: "Room 1", monthlyRent: 800 }),
      room({ id: "b", name: "Room 10", monthlyRent: 2400 }),
    ]);

    expect(resolveSubmissionRoom(sub, { unitLabel: "Room 1" })?.id).toBe("a");
  });

  it("still uses the only room when nothing contradicts it", () => {
    // No room choice and no label: the single room is the only placement this listing offers,
    // so it is the right answer rather than a guess between candidates.
    const sub = submission([room({ id: "only", name: "Room 6", monthlyRent: 800 })]);

    expect(resolveSubmissionRoom(sub, {})?.id).toBe("only");
  });
});
