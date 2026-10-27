import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { emptyHouseInfo, setHouseInfoValue, houseInfoSecretValues } from "@/lib/house-info";
import {
  moveInDetailsEventKey,
  moveInWhenLabel,
  renderMoveInDetails,
  renderRoomAssigned,
  roomAssignedEventKey,
  roomAssignmentTransition,
} from "@/lib/move-in-details-event";

/**
 * A3 (stay chat). Move-in details and room assigned are event cards. The Move-in card holds secrets; the text
 * NEVER carries one. Both events are idempotent so the welcome sequence and a manager's own send are one card.
 */
let houseInfo = emptyHouseInfo();
houseInfo = setHouseInfoValue(houseInfo, "access", "doorCode", "7431#");
houseInfo = setHouseInfoValue(houseInfo, "access", "gateCode", "9082");
houseInfo = setHouseInfoValue(houseInfo, "access", "keyPickup", "Lockbox under the mat, code 5566");
houseInfo = setHouseInfoValue(houseInfo, "access", "parking", "Street parking");
houseInfo = setHouseInfoValue(houseInfo, "wifi", "network", "Maple5");
houseInfo = setHouseInfoValue(houseInfo, "wifi", "password", "correct-horse-staple");

const FACTS = {
  residentName: "Maya Chen",
  propertyLabel: "4709A 8th Ave NE",
  addressLine: "4709A 8th Ave NE, 98115",
  roomLabel: "Room 3",
  moveInDateLabel: "Nov 1, 2026",
  checkInTime: "15:00",
  houseInfo,
};

describe("move-in details copy", () => {
  it("states the date and window, the street address, the room, and points at the lease packet for the code", () => {
    const rendered = renderMoveInDetails(FACTS)!;
    expect(rendered.subject).toBe("Move-in details");
    expect(rendered.text).toContain("Sun, Nov 1 after 3:00 pm");
    expect(rendered.text).toContain("4709A 8th Ave NE");
    expect(rendered.text).toContain("Room 3");
    expect(rendered.text).toContain("entry code is in the lease packet");
    expect(rendered.cardFact).toBe("Sun, Nov 1 after 3:00 pm · 4709A 8th Ave NE, 98115 · Room 3 · entry code in the lease packet · parking Street parking");
  });

  it("never writes a door code, gate code, lockbox, Wi-Fi password or the word password", () => {
    const rendered = renderMoveInDetails(FACTS)!;
    const everything = `${rendered.subject}\n${rendered.text}\n${rendered.smsText}\n${rendered.cardFact}`;
    for (const secret of houseInfoSecretValues(houseInfo)) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/password|passcode|lockbox/i);
    expect(everything).not.toContain("7431");
    expect(everything).not.toContain("9082");
    expect(everything).not.toContain("5566");
    expect(everything).not.toContain("correct-horse-staple");
  });

  it("a code typed into a fact the card does print (parking, the room name) is dropped, not printed", () => {
    const leaky = setHouseInfoValue(houseInfo, "access", "parking", "Gate 9082 then the left spot");
    const rendered = renderMoveInDetails({ ...FACTS, roomLabel: "Room 3 (door 7431#)", houseInfo: leaky })!;
    const everything = `${rendered.text}\n${rendered.cardFact}`;
    expect(everything).not.toContain("9082");
    expect(everything).not.toContain("7431");
    expect(everything).toContain("4709A 8th Ave NE");
  });

  it("a house with no secrets does not mention a lease packet", () => {
    const rendered = renderMoveInDetails({ ...FACTS, houseInfo: emptyHouseInfo() })!;
    expect(rendered.text).not.toMatch(/lease packet/i);
  });

  it("says nothing when there is no address to arrive at", () => {
    expect(renderMoveInDetails({ ...FACTS, addressLine: "", propertyLabel: "" })).toBeNull();
  });

  it("leaves out placeholder rooms and an unparseable date's weekday", () => {
    const rendered = renderMoveInDetails({ ...FACTS, roomLabel: "Not assigned yet", moveInDateLabel: "sometime soon" })!;
    expect(rendered.text).not.toContain("Not assigned yet");
    expect(moveInWhenLabel("sometime soon", "15:00")).toBe("sometime soon after 3:00 pm");
  });
});

describe("room assigned copy and transition", () => {
  it("names the room and the home; a change says so", () => {
    expect(renderRoomAssigned({ propertyLabel: "4709A 8th Ave NE", roomLabel: "Room 3" })?.text).toBe("You have been assigned Room 3 at 4709A 8th Ave NE.");
    expect(renderRoomAssigned({ propertyLabel: "4709A 8th Ave NE", roomLabel: "Room 4", changed: true })).toMatchObject({
      subject: "Room changed",
      text: "Your room at 4709A 8th Ave NE is now Room 4.",
    });
    expect(renderRoomAssigned({ propertyLabel: "4709A", roomLabel: "Room TBD" })).toBeNull();
  });

  it("fires when a manager sets or changes the room on a live approved row, and only then", () => {
    const approved = { bucket: "approved" as const, assignedRoomChoice: "prop-1::room-3" };
    expect(roomAssignmentTransition(null, approved)).toEqual({ choice: "prop-1::room-3", changed: false });
    expect(roomAssignmentTransition({ bucket: "approved", assignedRoomChoice: "prop-1::room-2" }, approved)).toEqual({ choice: "prop-1::room-3", changed: true });
    // The same room written again, a pending row, a withdrawn row and an unassigned row say nothing.
    expect(roomAssignmentTransition({ bucket: "approved", assignedRoomChoice: "prop-1::room-3" }, approved)).toBeNull();
    expect(roomAssignmentTransition(null, { bucket: "pending", assignedRoomChoice: "prop-1::room-3" })).toBeNull();
    expect(roomAssignmentTransition(null, { ...approved, withdrawnAt: "2026-10-01T00:00:00Z" })).toBeNull();
    expect(roomAssignmentTransition(null, { bucket: "approved" })).toBeNull();
  });

  it("keys: one card per residency and room; one move-in card per resident and home", () => {
    expect(roomAssignedEventKey("app-1", "prop-1::room-3")).toBe("room_assigned:app-1:prop-1::room-3");
    expect(roomAssignedEventKey("app-1", "prop-1::room-3")).not.toBe(roomAssignedEventKey("app-1", "prop-1::room-4"));
    expect(moveInDetailsEventKey("RES-1", "prop-1")).toBe(moveInDetailsEventKey("res-1", "prop-1"));
  });
});

// ---- the senders ---------------------------------------------------------------------------------------------
const emitted: Array<{ eventId: string; event: string; payload: Record<string, unknown>; recipients: Array<{ rendered: { text: string } }> }> = [];
const seen = new Set<string>();
vi.mock("@/lib/action-events.server", () => ({
  emitActionEvent: vi.fn(async (_db: unknown, input: { eventId: string; event: string; payload: Record<string, unknown>; recipients: Array<{ rendered: { text: string } }> }) => {
    const duplicate = seen.has(input.eventId);
    seen.add(input.eventId);
    if (!duplicate) emitted.push(input);
    return { eventId: input.eventId, duplicate, delivered: duplicate ? 0 : 1, submitted: 0, deferred: 0, failed: 0 };
  }),
}));
vi.mock("@/lib/domain-action-events.server", () => ({
  managerSender: vi.fn(async () => ({ userId: "mgr-1", email: "ambika@example.com", name: "Ambika" })),
}));
vi.mock("@/lib/resident-notice-channel.server", () => ({
  residentNoticeChannel: vi.fn(async () => "portal"),
}));

function propertyRecord() {
  return {
    id: "prop-1",
    property_data: {
      id: "prop-1",
      title: "4709A 8th Ave NE",
      buildingName: "4709A 8th Ave NE",
      address: "4709A 8th Ave NE, Seattle, WA",
      listingSubmission: {
        v: 1,
        buildingName: "4709A 8th Ave NE",
        address: "4709A 8th Ave NE",
        zip: "98115",
        houseRulesText: "",
        rooms: [{ id: "room-3", name: "Room 3", floor: "2", monthlyRent: 1150, availability: "Available now", moveInInstructions: "", moveInPhotoDataUrls: [], manualUnavailableRanges: [] }],
        bathrooms: [],
        sharedSpaces: [],
        quickFacts: [],
        bundles: [],
        housePhotoDataUrls: [],
        houseInfo,
        stayTimes: { checkInTime: "15:00" },
      },
    },
    row_data: {},
  };
}

const APPROVED: DemoApplicantRow = {
  id: "app-1",
  bucket: "approved",
  name: "Maya Chen",
  email: "maya@example.com",
  residentUserId: "res-1",
  property: "4709A 8th Ave NE",
  propertyId: "prop-1",
  assignedPropertyId: "prop-1",
  assignedRoomChoice: "prop-1::room-3",
  application: { propertyId: "prop-1", leaseStart: "2026-11-01" },
} as unknown as DemoApplicantRow;

function fakeDb(applications: DemoApplicantRow[] = [APPROVED]): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === "manager_application_records") {
        const q = {
          select: () => q,
          eq: () => q,
          order: () => Promise.resolve({ data: applications.map((row) => ({ id: row.id, row_data: row, updated_at: "2026-10-20T00:00:00Z" })), error: null }),
        };
        return q;
      }
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: () => Promise.resolve({ data: table === "manager_property_records" ? propertyRecord() : null, error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

describe("the senders", () => {
  beforeEach(() => {
    emitted.length = 0;
    seen.clear();
  });

  it("move-in details: one resident-copy event whose text carries no secret", async () => {
    const { emitMoveInDetails } = await import("@/lib/move-in-details-event.server");
    const result = await emitMoveInDetails(fakeDb(), { managerUserId: "mgr-1", residentEmail: "maya@example.com" });
    expect(result).toEqual({ ok: true, duplicate: false });
    expect(emitted).toHaveLength(1);
    const event = emitted[0]!;
    expect(event.event).toBe("move_in_details");
    expect(event.eventId).toBe("move_in_details:app-1:prop-1");
    expect(event.payload).toMatchObject({ propertyId: "prop-1" });
    const text = event.recipients[0]!.rendered.text;
    expect(text).toContain("4709A 8th Ave NE");
    expect(text).toContain("Room 3");
    for (const secret of houseInfoSecretValues(houseInfo)) expect(text + JSON.stringify(event.payload)).not.toContain(secret);
    expect(text).not.toMatch(/password/i);
  });

  it("the key is the stay's record, so a caller that can name the resident user and one that cannot are still ONE card", async () => {
    const { emitMoveInDetails } = await import("@/lib/move-in-details-event.server");
    // The stored application carries no residentUserId: only the welcome sequence knows it.
    const noUser = { ...APPROVED, residentUserId: undefined } as unknown as DemoApplicantRow;
    const first = await emitMoveInDetails(fakeDb([noUser]), { managerUserId: "mgr-1", residentEmail: "maya@example.com", residentUserId: "res-1" });
    const second = await emitMoveInDetails(fakeDb([noUser]), { managerUserId: "mgr-1", residentEmail: "maya@example.com" });
    expect(first).toEqual({ ok: true, duplicate: false });
    expect(second).toEqual({ ok: true, duplicate: true });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.eventId).toBe("move_in_details:app-1:prop-1");
  });

  it("the welcome sequence and a manager's own send are ONE card (same event key, second is a duplicate)", async () => {
    const { emitMoveInDetails } = await import("@/lib/move-in-details-event.server");
    const first = await emitMoveInDetails(fakeDb(), { managerUserId: "mgr-1", residentEmail: "maya@example.com", residentUserId: "res-1" });
    const second = await emitMoveInDetails(fakeDb(), { managerUserId: "mgr-1", residentEmail: "maya@example.com" });
    expect(first).toEqual({ ok: true, duplicate: false });
    expect(second).toEqual({ ok: true, duplicate: true });
    expect(emitted).toHaveLength(1);
  });

  it("move-in details: a resident with no placed home gets nothing", async () => {
    const { emitMoveInDetails } = await import("@/lib/move-in-details-event.server");
    const unplaced = { ...APPROVED, propertyId: "", assignedPropertyId: "", application: {} } as unknown as DemoApplicantRow;
    expect(await emitMoveInDetails(fakeDb([unplaced]), { managerUserId: "mgr-1", residentEmail: "maya@example.com" })).toEqual({ ok: false, reason: "no_home" });
    expect(await emitMoveInDetails(fakeDb([]), { managerUserId: "mgr-1", residentEmail: "maya@example.com" })).toEqual({ ok: false, reason: "no_home" });
    expect(emitted).toHaveLength(0);
  });

  it("room assigned: fires after the write, idempotent on residency and room; a new room is a new card", async () => {
    const { emitRoomAssignment } = await import("@/lib/move-in-details-event.server");
    const previous = { ...APPROVED, assignedRoomChoice: "" } as DemoApplicantRow;
    const first = await emitRoomAssignment(fakeDb(), { managerUserId: "mgr-1", previous, application: APPROVED });
    expect(first).toEqual({ ok: true, duplicate: false });
    expect(emitted[0]).toMatchObject({ event: "room_assigned", eventId: "room_assigned:app-1:prop-1::room-3" });
    expect(emitted[0]!.payload).toMatchObject({ roomLabel: "Room 3", propertyId: "prop-1" });
    expect(emitted[0]!.recipients[0]!.rendered.text).toBe("You have been assigned Room 3 at 4709A 8th Ave NE.");
    // The same assignment saved again: no transition, nothing sent. Replayed with no previous: the bus drops the duplicate.
    expect(await emitRoomAssignment(fakeDb(), { managerUserId: "mgr-1", previous: APPROVED, application: APPROVED })).toEqual({ ok: false, reason: "no_change" });
    expect(await emitRoomAssignment(fakeDb(), { managerUserId: "mgr-1", previous: null, application: APPROVED })).toEqual({ ok: true, duplicate: true });
    expect(emitted).toHaveLength(1);
  });

  it("room assigned: a change to a room that does not resolve to a name says nothing", async () => {
    const { emitRoomAssignment } = await import("@/lib/move-in-details-event.server");
    const moved = { ...APPROVED, assignedRoomChoice: "prop-1::ghost-room" } as DemoApplicantRow;
    const result = await emitRoomAssignment(fakeDb([moved]), { managerUserId: "mgr-1", previous: APPROVED, application: moved });
    expect(result).toEqual({ ok: false, reason: "no_room" });
    expect(emitted).toHaveLength(0);
  });
});
