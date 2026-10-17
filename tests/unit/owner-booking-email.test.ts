import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const emitActionEvent = vi.fn<(db: unknown, input: unknown) => Promise<unknown>>(async () => ({ eventId: "e", duplicate: false, delivered: 1, submitted: 0, deferred: 0, failed: 0 }));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: (db: unknown, input: unknown) => emitActionEvent(db, input) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://app.test" }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({ resolveManagerAssistantWorkspace: async () => ({ workspaceId: "ws1", isDefault: true }) }));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({ resolveWorkspaceWorkEmail: async () => ({ address: "work@mail.test", workspaceName: "Brooklyn" }) }));
const sendPortalConversationEmails = vi.fn(async (args: { toEmails: string[] }) => new Map(args.toEmails.map((to) => [to, { sent: true }])));
vi.mock("@/lib/portal-email-send.server", () => ({ sendPortalConversationEmails: (args: { toEmails: string[] }) => sendPortalConversationEmails(args) }));

import { emitChannelBookingEvent, emitNativeBookingEvent, renderOwnerBookingEmail } from "@/lib/channel-booking-events.server";

/** A db with the owner's profile, one property, and the claim table `sendManagerNoticeEmail` dedupes on. */
function fakeDb() {
  const claims = new Set<string>();
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () =>
        table === "profiles"
          ? { data: { email: "owner@example.com", full_name: "Owner" }, error: null }
          : { data: { property_data: { title: "5259 Brooklyn Ave", listingSubmission: { rooms: [{ id: "r1", name: "Room 3" }] } } }, error: null },
    };
    if (table === "portal_outbound_mail_records") {
      let id = "";
      chain.upsert = (row: { id: string }) => {
        id = row.id;
        return { select: async () => (claims.has(id) ? { data: [], error: null } : (claims.add(id), { data: [{ id }], error: null })) };
      };
      chain.delete = () => ({ eq: async (_c: string, value: string) => { claims.delete(value); return { error: null }; } });
    }
    return chain;
  };
  return { db: { from } as unknown as SupabaseClient, claims };
}

const channelInput = {
  event: "channel_booking_created" as const,
  connectionId: "c1",
  managerUserId: "m1",
  propertyId: "p1",
  roomId: "r1",
  provider: "airbnb" as const,
  propertyLabel: "5259 Brooklyn Ave",
  roomLabel: "Room 3",
  range: { id: "u1", sourceUid: "u1", summary: "Reserved", start: "2026-10-12", end: "2026-10-14" },
};

describe("the owner's email for every booking", () => {
  beforeEach(() => { emitActionEvent.mockClear(); sendPortalConversationEmails.mockClear(); });

  it("always emails the owner's login address from the work email, whatever the bus notice does", async () => {
    const { db } = fakeDb();
    // The bus is mocked: it sends nothing, exactly as a manager whose alert destination is "none" would see.
    await emitChannelBookingEvent(db, channelInput);
    expect(emitActionEvent).toHaveBeenCalledTimes(1);
    expect(sendPortalConversationEmails).toHaveBeenCalledTimes(1);
    const sent = sendPortalConversationEmails.mock.calls[0]![0] as unknown as { toEmails: string[]; fromAddress: string; subject: string; text: string; senderUserId: string };
    expect(sent.toEmails).toEqual(["owner@example.com"]);
    expect(sent.fromAddress).toBe("PropLane Assistant · Brooklyn <work@mail.test>");
    expect(sent.senderUserId).toBe("m1");
    expect(sent.subject).toBe("New booking · 5259 Brooklyn Ave · Room 3");
    for (const line of ["House: 5259 Brooklyn Ave", "Room: Room 3", "Guest: Booked (Airbnb)", "Dates: Oct 12 – Oct 15 (3 nights)", "Source: Airbnb", "Open in PropLane: https://app.test/portal/bookings/"]) {
      expect(sent.text).toContain(line);
    }
  });

  it("sends once: a second sync of the same booking (same event id) sends no second email", async () => {
    const { db, claims } = fakeDb();
    await emitChannelBookingEvent(db, channelInput);
    await emitChannelBookingEvent(db, channelInput);
    expect(emitActionEvent).toHaveBeenCalledTimes(2);
    expect(sendPortalConversationEmails).toHaveBeenCalledTimes(1);
    expect(claims.size).toBe(1);
  });

  it("shares the bus notice's own email key, so a manager whose destination is email gets one mail, not two", async () => {
    const { db, claims } = fakeDb();
    const { managerNoticeEmailClaimId } = await import("@/lib/manager-notice-email.server");
    await emitChannelBookingEvent(db, channelInput);
    const eventId = (emitActionEvent.mock.calls[0]![1] as { eventId: string }).eventId;
    expect([...claims]).toEqual([managerNoticeEmailClaimId("m1", `action-event:${eventId}:manager`)]);
  });

  it("a cancellation is its own event and its own email", async () => {
    const { db } = fakeDb();
    await emitChannelBookingEvent(db, channelInput);
    await emitChannelBookingEvent(db, { ...channelInput, event: "channel_booking_cancelled" });
    expect(sendPortalConversationEmails).toHaveBeenCalledTimes(2);
    expect((sendPortalConversationEmails.mock.calls[1]![0] as unknown as { subject: string }).subject).toBe("Booking cancelled · 5259 Brooklyn Ave · Room 3");
  });

  it("still emails when the bus notice throws, and then surfaces the bus error", async () => {
    const { db } = fakeDb();
    emitActionEvent.mockRejectedValueOnce(new Error("bus down"));
    await expect(emitChannelBookingEvent(db, channelInput)).rejects.toThrow("bus down");
    expect(sendPortalConversationEmails).toHaveBeenCalledTimes(1);
  });

  it("never fails the booking when the mail cannot go out", async () => {
    const { db } = fakeDb();
    sendPortalConversationEmails.mockRejectedValueOnce(new Error("smtp down"));
    await expect(emitChannelBookingEvent(db, channelInput)).resolves.toBeUndefined();
  });
});

describe("native bookings (made in PropLane)", () => {
  beforeEach(() => { emitActionEvent.mockClear(); sendPortalConversationEmails.mockClear(); });
  const native = { blockId: "block-1", managerUserId: "m1", propertyId: "p1", roomId: "r1", guestName: "Maya Chen", checkIn: "2026-10-12", checkOut: "2026-10-15" };

  it("created emits booking_created on the channel_booking domain and emails the owner with house, room, guest, dates and source", async () => {
    const { db } = fakeDb();
    await emitNativeBookingEvent(db, { ...native, event: "booking_created" });
    expect(emitActionEvent.mock.calls[0]![1]).toMatchObject({
      eventId: "native:block-1:booking_created",
      domain: "channel_booking",
      event: "booking_created",
      managerUserId: "m1",
      payload: expect.objectContaining({ blockId: "block-1", provider: "proplane", guestLabel: "Maya Chen" }),
    });
    const sent = sendPortalConversationEmails.mock.calls[0]![0] as unknown as { toEmails: string[]; text: string };
    expect(sent.toEmails).toEqual(["owner@example.com"]);
    for (const line of ["House: 5259 Brooklyn Ave", "Room: Room 3", "Guest: Maya Chen", "Dates: Oct 12 – Oct 15 (3 nights)", "Source: PropLane", "/portal/bookings/block%3Ablock-1/"]) {
      expect(sent.text).toContain(line);
    }
  });

  it("cancelled emits booking_cancelled, and a repeat (cancel then delete) sends nothing twice", async () => {
    const { db } = fakeDb();
    await emitNativeBookingEvent(db, { ...native, event: "booking_cancelled" });
    await emitNativeBookingEvent(db, { ...native, event: "booking_cancelled" });
    expect(emitActionEvent.mock.calls.map((call) => (call[1] as { event: string }).event)).toEqual(["booking_cancelled", "booking_cancelled"]);
    expect(sendPortalConversationEmails).toHaveBeenCalledTimes(1);
    expect((sendPortalConversationEmails.mock.calls[0]![0] as unknown as { subject: string }).subject).toBe("Booking cancelled · 5259 Brooklyn Ave · Room 3");
  });

  it("an open-ended stay says so", () => {
    expect(renderOwnerBookingEmail({ created: true, guest: "Maya", stayLabel: "Oct 12 – open-ended", sourceLabel: "PropLane" }).text).toContain("Dates: Oct 12 – open-ended");
  });
});
