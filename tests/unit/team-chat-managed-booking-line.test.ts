/**
 * A routine booking event has no Team chat line, except on a PropLane-managed workspace, whose staff have no other
 * in-app record of it. That line used to be derived from the notice's bare subject ("Schedule · New Airbnb booking",
 * texted on as "PropLane: Schedule · New Airbnb booking"); it now names the house, room and dates.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let MANAGED = true;

const postTeamThreadMessage = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true as const, posted: true })));
const relay = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => []));

vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: vi.fn(async () => ({ delivered: true, suppressed: false })) }));
vi.mock("@/lib/work-number-recipients.server", () => ({ notifyWorkNumberRecipients: vi.fn(async () => undefined) }));
vi.mock("@/lib/service/service-alert-targets.server", () => ({
  isManagedWorkspaceId: async () => MANAGED,
  notifyServiceAlertTargets: async () => undefined,
}));
vi.mock("@/lib/service/service-manager-alerts.server", () => ({ alertServiceManagerFromNotice: async () => "skipped" }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({
  resolveManagerAssistantWorkspace: async () => ({ workspaceId: WS }),
  userDefaultWorkspaceId: async () => WS,
}));
vi.mock("@/lib/managed-finance/payee.server", () => ({ resolveManagedPayee: async () => null }));
vi.mock("@/lib/team-comms.server", () => ({
  ensureWorkspaceTeamThread: async () => "thread-1",
  postTeamThreadMessage: (...args: unknown[]) => postTeamThreadMessage(...args),
  relayTeamChatMessageToSms: (...args: unknown[]) => relay(...args),
  resolveWorkspaceTeamMembersWithGrants: async () => [],
}));
vi.mock("@/lib/workspace-team-recipients.server", () => ({
  memberReceivesNotice: () => true,
  resolveWorkspaceNoticeRecipients: async () => [{ userId: ADMIN }],
}));

import { notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";
import { routineBookingTeamNotice } from "@/lib/action-events.server";

const db = { from: () => ({}) } as never;
const posted = () => postTeamThreadMessage.mock.calls.map((c) => (c[1] as { text: string }).text);

const event = (payload: Record<string, unknown>, eventType = "channel_booking_created") => ({
  eventKey: "conn-1:r1:2026-11-25:2026-11-27:channel_booking_created",
  domain: "channel_booking",
  eventType,
  rendered: { subject: "New Airbnb booking", text: "New booking: ..." },
  payload,
});
const BOOKING_PAYLOAD = {
  guestLabel: "Airbnb guest · HMWR9TARYS",
  propertyLabel: "5259 Brooklyn Ave",
  roomLabel: "Room 3",
  stayLabel: "Nov 25 – Nov 28 (3 nights)",
  channelLabel: "Airbnb",
};

beforeEach(() => {
  postTeamThreadMessage.mockClear();
  relay.mockClear();
  MANAGED = true;
});

describe("routineBookingTeamNotice", () => {
  it("names the house, room, dates and channel; an unnamed guest is left out", () => {
    expect(routineBookingTeamNotice(event(BOOKING_PAYLOAD))).toEqual({
      messageId: "action-event:conn-1:r1:2026-11-25:2026-11-27:channel_booking_created:team",
      text: "Booking created: 5259 Brooklyn Ave, Room 3, Nov 25 – Nov 28 (3 nights), Airbnb.",
    });
  });

  it("a real guest name leads; a Booking.com privacy-stripped stay is still a booking", () => {
    expect(routineBookingTeamNotice(event({ ...BOOKING_PAYLOAD, guestLabel: "Priya Nair" }))?.text).toBe(
      "Booking created: Priya Nair, 5259 Brooklyn Ave, Room 3, Nov 25 – Nov 28 (3 nights), Airbnb.",
    );
    expect(
      routineBookingTeamNotice(event({ ...BOOKING_PAYLOAD, guestLabel: "Booking.com guest", channelLabel: "Booking.com" }))?.text,
    ).toBe("Booking created: 5259 Brooklyn Ave, Room 3, Nov 25 – Nov 28 (3 nights), Booking.com.");
    expect(routineBookingTeamNotice(event({ ...BOOKING_PAYLOAD, guestLabel: "Sam Lee", channelLabel: "PropLane" }, "booking_cancelled"))?.text).toBe(
      "Booking cancelled: Sam Lee, 5259 Brooklyn Ave, Room 3, Nov 25 – Nov 28 (3 nights), PropLane.",
    );
  });

  it("is only for routine booking events, and only with facts to say", () => {
    expect(routineBookingTeamNotice(event(BOOKING_PAYLOAD, "channel_booking_clash"))).toBeNull();
    expect(routineBookingTeamNotice({ ...event(BOOKING_PAYLOAD), domain: "tour" })).toBeNull();
    expect(routineBookingTeamNotice(event({ guestLabel: "Priya Nair", channelLabel: "Airbnb" }))).toBeNull();
  });
});

describe("a managed workspace's routine booking line", () => {
  const notice = {
    ownerManagerUserId: ADMIN,
    propertyId: "house-1",
    workspaceId: WS,
    module: "calendar" as const,
    subject: "New Airbnb booking",
    text: "New booking: Airbnb guest HMWR9TARYS, 5259 Brooklyn Ave · Room 3, Nov 25–28 (3 nights).",
    idempotencyKey: "action-event:e1:manager",
    noTeamNotice: true,
  };

  it("posts the line with the facts, not the bare subject", async () => {
    const managedTeamNotice = routineBookingTeamNotice(event(BOOKING_PAYLOAD))!;
    await notifyPropertyScopedManagersFromAgent(db, { ...notice, managedTeamNotice });
    expect(posted()).toEqual(["Booking created: 5259 Brooklyn Ave, Room 3, Nov 25 – Nov 28 (3 nights), Airbnb."]);
    // The SMS relay texts this same posted line ("PropLane: <line>").
  });

  it("with no line given it still falls back to the derived one (other callers unchanged)", async () => {
    await notifyPropertyScopedManagersFromAgent(db, notice);
    expect(posted()).toEqual(["Schedule · New Airbnb booking"]);
  });

  it("a self-serve workspace posts no routine booking line at all", async () => {
    MANAGED = false;
    await notifyPropertyScopedManagersFromAgent(db, { ...notice, managedTeamNotice: routineBookingTeamNotice(event(BOOKING_PAYLOAD))! });
    expect(postTeamThreadMessage).not.toHaveBeenCalled();
  });
});
