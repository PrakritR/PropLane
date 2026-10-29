/* eslint-disable @typescript-eslint/no-explicit-any -- loose recorders for a fake client */
/**
 * "I'm in" (checkin-1028, decision D3): resident-session only, idempotent, ONE manager notice. Real
 * `recordResidentCheckIn` and `loadStayCheckIn` against an in-memory fake of the three tables they read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: emit }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://prop-lane.space" }));
vi.mock("@/lib/resident-portal-access", () => ({
  loadResidentLeaseSignedStatus: async () => true,
  loadResidentManagerAttestedTenancy: async () => false,
}));

import { checkedInNoticeText } from "@/lib/check-in-notice-text";
import { parseCheckInKey, recordResidentCheckIn } from "@/lib/check-in-event.server";
import { loadStayCheckIn } from "@/lib/check-in.server";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const OWNER = "owner-1";
const GUEST = "guest-1";
const HOUSE = "mgr-house-1";

function makeDb(stay: { bookingStatus?: string; residentUserId?: string } = {}) {
  const state = {
    stay: {
      id: "block-1",
      manager_user_id: OWNER,
      property_id: HOUSE,
      record_type: "room_date_block",
      row_data: {
        propertyId: HOUSE,
        roomId: "room-9",
        checkIn: "2026-10-30",
        checkOut: "2026-11-02",
        residentName: "Matthew Rao",
        residentUserId: stay.residentUserId ?? GUEST,
        bookingStatus: stay.bookingStatus ?? "confirmed",
        stayDetails: {} as Record<string, unknown>,
      } as Record<string, any>,
    },
  };
  const property = {
    id: HOUSE,
    row_data: { zip: "98105" },
    property_data: {
      buildingName: "4709A",
      address: "4709A 8th Ave NE",
      listingSubmission: {
        ...createDefaultListingSubmission(),
        v: 1,
        zip: "98105",
        buildingName: "4709A",
        address: "4709A 8th Ave NE",
        houseInfo: { access: { doorCode: "7500" }, wifi: { network: "Net", password: "pw-123" }, internal: { pantryCode: "2410" } },
        rooms: [{ ...createDefaultListingSubmission().rooms[0]!, id: "room-9", name: "Room 9", doorCode: "9921" }],
      },
    },
  };
  const getPath = (row: any, column: string) => {
    const path = column.replace(/^row_data/, "").split(/->>|->/).filter(Boolean);
    return path.reduce((value: any, key) => (value == null ? value : value[key]), row.row_data);
  };
  const db = {
    from(table: string) {
      if (table === "portal_schedule_records") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: JSON.parse(JSON.stringify(state.stay)), error: null }) }) }),
          update: (patch: Record<string, any>) => {
            const conditions: Array<(row: any) => boolean> = [];
            const api: any = {
              eq: () => api,
              filter: (column: string, op: string) => {
                if (op === "is") conditions.push((row) => getPath(row, column) == null);
                return api;
              },
              select: async () => {
                if (!conditions.every((test) => test(state.stay))) return { data: [], error: null };
                state.stay = { ...state.stay, ...patch } as typeof state.stay;
                return { data: [{ id: state.stay.id }], error: null };
              },
              // A bare `await update(...).eq(...)` (the rollback) applies the patch.
              then: (resolve: (value: { error: null }) => void) => {
                state.stay = { ...state.stay, ...patch } as typeof state.stay;
                resolve({ error: null });
              },
            };
            return api;
          },
        };
      }
      if (table === "manager_property_records") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: property, error: null }) }) }) };
      }
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "owner@example.com", full_name: "Ambika" }, error: null }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as never;
  return { db, state };
}

// Thu Oct 30 15:00 PDT = 22:00Z. The reveal is 24 h earlier.
const REVEALED = new Date("2026-10-30T23:00:00.000Z");
const TOO_EARLY = new Date("2026-10-27T18:00:00.000Z");

beforeEach(() => emit.mockClear());

describe("the key", () => {
  it("parses a stay or a tenancy key and nothing else", () => {
    expect(parseCheckInKey("stay:block-1")).toEqual({ kind: "stay", id: "block-1" });
    expect(parseCheckInKey("tenancy:abc_123")).toEqual({ kind: "tenancy", id: "abc_123" });
    for (const bad of ["", "stay:", "other:1", "stay:a b", "stay:../x", 7, null, undefined]) expect(parseCheckInKey(bad)).toBeNull();
  });

  it("the notice reads 'First name checked in to house room'", () => {
    expect(checkedInNoticeText({ residentName: "Matthew Rao", propertyLabel: "4709A", roomLabel: "Room 9" })).toBe("Matthew checked in to 4709A Room 9");
    expect(checkedInNoticeText({ residentName: "", propertyLabel: "4709A", roomLabel: "" })).toBe("A resident checked in to 4709A");
  });
});

describe("the stay guide a guest is served", () => {
  it("masks the codes before the reveal and carries them after, never the Internal section", async () => {
    const { db } = makeDb();
    const early = await loadStayCheckIn(db, GUEST, "block-1", TOO_EARLY);
    expect(early?.reveal.revealed).toBe(false);
    expect(early?.guide.unlockLabel).toBe("Thu 3:00 PM");
    expect(JSON.stringify(early?.guide)).not.toMatch(/7500|9921|pw-123|2410/);

    const open = await loadStayCheckIn(db, GUEST, "block-1", REVEALED);
    expect(open?.reveal.revealed).toBe(true);
    expect(JSON.stringify(open?.guide)).toMatch(/7500/);
    expect(JSON.stringify(open?.guide)).toMatch(/9921/);
    expect(JSON.stringify(open?.guide)).not.toContain("2410");
    expect(open?.guide.checkInKey).toBe("stay:block-1");
  });

  it("is not served to someone else's login, nor for a hold", async () => {
    expect(await loadStayCheckIn(makeDb().db, "someone-else", "block-1", REVEALED)).toBeNull();
    expect(await loadStayCheckIn(makeDb({ bookingStatus: "hold" }).db, GUEST, "block-1", REVEALED)).toBeNull();
  });
});

describe("I'm in", () => {
  it("stamps once, notifies the owner once, and a second tap changes nothing", async () => {
    const { db, state } = makeDb();
    const first = await recordResidentCheckIn(db, { userId: GUEST, email: "m@example.com", key: { kind: "stay", id: "block-1" }, now: REVEALED });
    expect(first).toEqual({ ok: true, checkedInAt: REVEALED.toISOString(), alreadyCheckedIn: false });
    expect(state.stay.row_data.stayDetails.checkedInAt).toBe(REVEALED.toISOString());
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0]![1] as any;
    expect(call).toMatchObject({
      eventId: "resident_checked_in:stay:block-1",
      domain: "channel_booking",
      event: "resident_checked_in",
      managerUserId: OWNER,
    });
    expect(call.recipients).toHaveLength(1);
    expect(call.recipients[0]).toMatchObject({ audience: "manager", userId: OWNER });
    expect(call.recipients[0].rendered.text).toBe("Matthew checked in to 4709A Room 9");

    const second = await recordResidentCheckIn(db, { userId: GUEST, email: "m@example.com", key: { kind: "stay", id: "block-1" }, now: new Date(REVEALED.getTime() + 60_000) });
    expect(second).toEqual({ ok: true, checkedInAt: REVEALED.toISOString(), alreadyCheckedIn: true });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("refuses before the reveal and for a stay that is not the caller's, and notifies nobody", async () => {
    const { db, state } = makeDb();
    const early = await recordResidentCheckIn(db, { userId: GUEST, email: "m@example.com", key: { kind: "stay", id: "block-1" }, now: TOO_EARLY });
    expect(early).toMatchObject({ ok: false, status: 403 });
    const stranger = await recordResidentCheckIn(db, { userId: "someone-else", email: "x@example.com", key: { kind: "stay", id: "block-1" }, now: REVEALED });
    expect(stranger).toMatchObject({ ok: false, status: 404 });
    expect(emit).not.toHaveBeenCalled();
    expect(state.stay.row_data.stayDetails.checkedInAt).toBeUndefined();
  });

  it("gives the stamp back when the notice cannot be sent, so the tap can be retried", async () => {
    const { db, state } = makeDb();
    emit.mockRejectedValueOnce(new Error("bus down"));
    const failed = await recordResidentCheckIn(db, { userId: GUEST, email: "m@example.com", key: { kind: "stay", id: "block-1" }, now: REVEALED });
    expect(failed).toMatchObject({ ok: false, status: 500 });
    expect(state.stay.row_data.stayDetails.checkedInAt).toBeUndefined();
    const retry = await recordResidentCheckIn(db, { userId: GUEST, email: "m@example.com", key: { kind: "stay", id: "block-1" }, now: REVEALED });
    expect(retry).toMatchObject({ ok: true, alreadyCheckedIn: false });
  });
});
