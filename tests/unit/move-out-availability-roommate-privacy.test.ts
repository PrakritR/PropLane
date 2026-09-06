import { describe, expect, it } from "vitest";
import { checkMoveOutAvailabilityForLease } from "@/lib/lease-amendment.server";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

/**
 * The move-out availability check reads OTHER residents' lease rows by property +
 * room. Its room-match guard was effectively unreachable while rooms were 1:1;
 * per-bed rentals make it true for every roommate, so this endpoint becomes both
 * a correctness problem (a roommate blocking an extension when a bed is free) and
 * a disclosure one (the caller controls newLeaseEnd, so any peer date returned
 * here can be binary-searched out of it).
 */

const SIGNATURE = { name: "A Person", signedAtIso: "2026-01-01T00:00:00.000Z" };

function signedLease(opts: {
  email: string;
  roomId: string;
  leaseStart: string;
  leaseEnd: string | null;
}): LeasePipelineRow {
  return {
    id: `lease-${opts.email}`,
    residentName: "Resident",
    residentEmail: opts.email,
    unit: "Room A",
    propertyId: "prop-1",
    roomChoice: `prop-1::${opts.roomId}`,
    status: "Fully Signed",
    managerSignature: SIGNATURE,
    residentSignature: SIGNATURE,
    application: { leaseStart: opts.leaseStart, leaseEnd: opts.leaseEnd ?? undefined },
    // Deliberately present: these are exactly the fields that must never travel
    // back to a roommate in a refusal.
    signedRentLabel: "$700 / month",
    generatedHtml: "<html>SECRET LEASE BODY</html>",
  } as unknown as LeasePipelineRow;
}

/** Minimal stand-in for the two PostgREST chains this function issues. */
function fakeDb(opts: { capacity?: number; peers: LeasePipelineRow[]; blocked?: { start: string; end: string } }) {
  const room: Record<string, unknown> = { id: "r1", name: "Room A", monthlyRent: 700, availability: "Now" };
  if (opts.capacity !== undefined) room.occupancyCapacity = opts.capacity;
  if (opts.blocked) room.manualUnavailableRanges = [{ id: "b1", ...opts.blocked }];

  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.neq = self;
      chain.order = self;
      chain.range = () =>
        Promise.resolve({
          data: opts.peers.map((row, i) => ({ id: `rec-${i}`, row_data: { ...row, bucket: "approved", assignedRoomChoice: row.roomChoice }, resident_email: row.residentEmail })),
        });
      chain.maybeSingle = () =>
        Promise.resolve({
          data:
            table === "manager_property_records"
              ? {
                  id: "prop-1",
                  property_data: {
                    listingSubmission: {
                      v: 1,
                      rooms: [room],
                      bathrooms: [],
                      sharedSpaces: [],
                      bundles: [],
                      quickFacts: [],
                    },
                  },
                  row_data: {},
                }
              : null,
        });
      return chain;
    },
  } as never;
}

const MINE = signedLease({ email: "me@example.com", roomId: "r1", leaseStart: "2026-01-01", leaseEnd: "2026-06-30" });
const RECORD = { property_id: "prop-1" };

describe("a roommate must not block an extension while a bed is free", () => {
  it("allows the extension when the shared room still has capacity", async () => {
    const peer = signedLease({ email: "peer@example.com", roomId: "r1", leaseStart: "2026-01-01", leaseEnd: "2026-12-31" });
    const result = await checkMoveOutAvailabilityForLease(
      fakeDb({ capacity: 2, peers: [peer] }),
      MINE,
      RECORD,
      "2026-09-30",
    );
    expect(result.ok).toBe(true);
  });

  it("still refuses once the peers alone fill every bed", async () => {
    const peers = [
      signedLease({ email: "a@example.com", roomId: "r1", leaseStart: "2026-01-01", leaseEnd: "2026-12-31" }),
      signedLease({ email: "b@example.com", roomId: "r1", leaseStart: "2026-01-01", leaseEnd: "2026-12-31" }),
    ];
    const result = await checkMoveOutAvailabilityForLease(
      fakeDb({ capacity: 2, peers }),
      MINE,
      RECORD,
      "2026-09-30",
    );
    expect(result.ok).toBe(false);
  });

  it("keeps a single-occupancy room refusing exactly as it did before", async () => {
    const peer = signedLease({ email: "peer@example.com", roomId: "r1", leaseStart: "2026-07-01", leaseEnd: "2026-12-31" });
    const result = await checkMoveOutAvailabilityForLease(fakeDb({ peers: [peer] }), MINE, RECORD, "2026-09-30");
    expect(result.ok).toBe(false);
  });

  it("ignores a peer in a different room", async () => {
    const peer = signedLease({ email: "peer@example.com", roomId: "r2", leaseStart: "2026-01-01", leaseEnd: "2026-12-31" });
    const result = await checkMoveOutAvailabilityForLease(fakeDb({ peers: [peer] }), MINE, RECORD, "2026-09-30");
    expect(result.ok).toBe(true);
  });
});

describe("a resident learns nothing about the roommate who blocked them", () => {
  it("returns a generic refusal with no peer dates, name, rent or document", async () => {
    const peer = signedLease({ email: "peer@example.com", roomId: "r1", leaseStart: "2026-07-15", leaseEnd: "2027-03-31" });
    const result = await checkMoveOutAvailabilityForLease(fakeDb({ peers: [peer] }), MINE, RECORD, "2026-09-30");
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("2026-07-15"); // the peer's lease start
    expect(serialized).not.toContain("2027-03-31"); // the peer's lease end
    expect(serialized).not.toContain("peer@example.com");
    expect(serialized).not.toContain("SECRET LEASE BODY");
    expect(serialized).not.toContain("$700");
    expect(result.nextAvailableDate ?? null).toBeNull();
    expect(result.reason).toBe("No bed is available in this room for the requested dates.");
  });

  it("defaults to the resident-safe answer when no audience is named", async () => {
    // Fail closed: a new caller that forgets the argument discloses LESS, not more.
    const peer = signedLease({ email: "peer@example.com", roomId: "r1", leaseStart: "2026-07-15", leaseEnd: "2027-03-31" });
    const result = await checkMoveOutAvailabilityForLease(fakeDb({ peers: [peer] }), MINE, RECORD, "2026-09-30");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain("2026-07-15");
  });
});

describe("a manager owns the property, so they still get the detail", () => {
  it("names the blocking start date and the next available date", async () => {
    const peer = signedLease({ email: "peer@example.com", roomId: "r1", leaseStart: "2026-07-15", leaseEnd: "2027-03-31" });
    const result = await checkMoveOutAvailabilityForLease(
      fakeDb({ peers: [peer] }),
      MINE,
      RECORD,
      "2026-09-30",
      undefined,
      "manager",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("2026-07-15");
    expect(result.nextAvailableDate).toBe("2027-03-31");
  });
});

describe("a manager-set block is the manager's own data, not a peer's", () => {
  it("describes the blocked period to a resident too", async () => {
    const result = await checkMoveOutAvailabilityForLease(
      fakeDb({ capacity: 2, peers: [], blocked: { start: "2026-08-01", end: "2026-08-31" } }),
      MINE,
      RECORD,
      "2026-09-30",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("2026-08-01");
    expect(result.nextAvailableDate).toBe("2026-08-31");
  });
});

describe("non-extension directions are untouched", () => {
  it("permits shortening a lease", async () => {
    const result = await checkMoveOutAvailabilityForLease(fakeDb({ peers: [] }), MINE, RECORD, "2026-05-01");
    expect(result).toEqual({ ok: true, direction: "decrease" });
  });

  it("refuses a move-out before the lease even starts", async () => {
    const result = await checkMoveOutAvailabilityForLease(fakeDb({ peers: [] }), MINE, RECORD, "2025-01-01");
    expect(result.ok).toBe(false);
  });

  it("permits an unchanged date", async () => {
    const result = await checkMoveOutAvailabilityForLease(fakeDb({ peers: [] }), MINE, RECORD, "2026-06-30");
    expect(result).toEqual({ ok: true, direction: "same" });
  });
});
