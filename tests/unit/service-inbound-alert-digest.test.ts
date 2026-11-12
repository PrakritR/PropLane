import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

const sendFromService = vi.fn(async (..._a: unknown[]) => ({ ok: true as const }) as { ok: true } | { ok: false; reason: string });
vi.mock("@/lib/service/service-manager.server", () => ({
  sendTextFromServiceOwner: (...a: unknown[]) => sendFromService(...a),
  readServiceManagerSettings: async () => null,
}));
vi.mock("@/lib/service/service-catalog.server", () => ({ readPlatformServiceOwnerId: async () => "svc-owner" }));
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: async () => ({ status: "sent" }) }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: async () => ({ delivered: true }) }));
const alertPhones = vi.fn(async (..._a: unknown[]) => ({ texted: 1, emailed: 0 }));
vi.mock("@/lib/one-number/ops-alerts.server", () => ({ alertPhonesOf: (...a: unknown[]) => alertPhones(...a) }));
const entries = vi.fn();
vi.mock("@/lib/occupancy/snapshot.server", () => ({ occupancyEntriesForManager: (...a: unknown[]) => entries(...a) }));
vi.mock("@/lib/bookings/property-stay-times.server", () => ({
  propertyStayClockFromRecord: () => ({ times: { checkInTime: "15:00", checkOutTime: "11:00" }, timeZone: "America/Los_Angeles" }),
}));
let roster: Array<{ userId: string; isOwner: boolean; role: string | null }> = [];
vi.mock("@/lib/workspace-team-recipients.server", () => ({ resolveWorkspaceNoticeRecipients: async () => roster }));

import { runCheckinCheckoutDigest } from "@/lib/one-number/checkin-digest.server";
import { alertOpsOfInboundText } from "@/lib/one-number/inbound-alert.server";
import { buildInboundAlertText, inboundGist } from "@/lib/one-number/inbound-alert";
import { composeServiceDigest, leadsDigestLine } from "@/lib/one-number/service-digest";
import { isOutboundOnlyOwnerSms, isSystemOnlyOwnerThread, type ManagedOwnerIdentity } from "@/lib/communication/managed-owner-thread";

const CAPTAIN = "+15103098345";
const SEVEN = () => new Date("2026-11-12T15:00:00Z"); // 7 AM PST

function seed() {
  return createFakeDb({
    portal_workspaces: [{ id: "ws-amb", name: "1. Ambika", owner_user_id: "amb", is_service: true, is_default: true }],
    workspace_work_number_recipients: [{ id: "r1", owner_user_id: "amb", label: "PropLane admin", phone: CAPTAIN, email: null, created_at: "2026-11-04T01:18:09Z" }],
    manager_property_records: [{ id: "p1", workspace_id: "ws-amb", manager_user_id: "amb", row_data: { address: "5259 Brooklyn Ave" }, property_data: {} }],
    account_link_invites: [],
    profiles: [
      { id: "cap", email: "c@x.com", phone: CAPTAIN, phone_verified_at: "2026-11-06T02:16:49Z", full_name: "Prakrit" },
      { id: "amb", email: "ogambik2@gmail.com", phone: "+15105791976", phone_verified_at: "2026-09-01T00:00:00Z", full_name: "Ambika Mago" },
    ],
    profile_roles: [{ user_id: "cap", role: "admin" }],
    manager_sms_contacts: [{ manager_user_id: "amb", workspace_id: "ws-amb", phone_e164: "+12065550177", display_name: "Maria Lopez", counterparty_role: "prospect", created_at: "2026-11-12T01:00:00Z" }],
    sms_unassigned_leads: [
      { phone_key: "2065550188", assigned_workspace_id: "ws-amb", assigned_property_id: "p1", created_at: "2026-11-11T20:00:00Z" },
      { phone_key: "2065550199", assigned_workspace_id: null, assigned_property_id: null, created_at: "2026-11-12T02:00:00Z" },
      { phone_key: "2065550100", assigned_workspace_id: null, assigned_property_id: null, created_at: "2026-11-01T02:00:00Z" },
    ],
    payment_reminder_occurrences: [
      ...Array.from({ length: 9 }, (_, i) => ({ manager_user_id: "amb", recipient_email: `r${i}@x.com`, created_at: "2026-11-12T00:30:00Z" })),
    ],
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendFromService.mockResolvedValue({ ok: true });
  roster = [{ userId: "amb", isOwner: true, role: null }];
  entries.mockResolvedValue({
    entries: [
      { source: "airbnb", propertyId: "p1", propertyLabel: "5259", roomId: "r4", roomLabel: "Room 4", summary: "Anthony", start: "2026-11-12", end: "2026-11-14" },
      { source: "airbnb", propertyId: "p1", propertyLabel: "5259", roomId: "r7", roomLabel: "Room 7", summary: "Kumaran", start: "2026-11-09", end: "2026-11-11" },
    ],
  });
});

describe("the inbound alert text: who, which house, what they want, a link", () => {
  const link = "https://proplane.ai/auth/sign-in?next=%2Fportal%2Fcommunication%2Finbox%2Funopened";
  it("names the sender and house, gives the gist, links the portal, and stays GSM-7 under 300 characters", () => {
    const text = buildInboundAlertText({ kind: "resident", name: "Vaishnavi Sharma", phone: "+12065550101", house: "5259 Brooklyn", body: "The toilet in room 3 is leaking, can someone come today?", link });
    expect(text).toContain("Resident Vaishnavi Sharma (5259 Brooklyn) - resident reports a repair issue");
    expect(text).toContain(link);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
  });
  it("falls back to the last four digits and says the house is not known yet; a lead asks for a tour", () => {
    const text = buildInboundAlertText({ kind: "prospect", phone: "+12065550188", house: null, body: "hi is there a room open, can I tour saturday", link });
    expect(text).toContain("Lead ***0188 (house not known yet) - lead wants a tour");
    expect(inboundGist("owner", "what's my balance and rent this month")).toBe("owner asking about rent or money");
  });
  it("never carries a card or bank number from the quoted words, and flattens quotes and links", () => {
    const text = buildInboundAlertText({ kind: "unknown", phone: "+12065550188", house: null, body: 'my card 4242 4242 4242 4242 pay here "now" https://evil.example/x', link });
    expect(text).not.toMatch(/4242 ?4242/);
    expect(text).not.toContain("evil.example");
  });
});

describe("alertOpsOfInboundText", () => {
  it("a text to a managed workspace tells its alert phone through the platform, once per MessageSid, with the owner shown as Owner", async () => {
    const db = seed();
    expect(await alertOpsOfInboundText(db, { workspaceId: "ws-amb", managerId: "amb", fromPhone: "+15105791976", body: "can you send my statement?", messageSid: "SM1", onPropLaneLine: false })).toBe("sent");
    const [, call] = sendFromService.mock.calls[0]! as [unknown, { toPhone: string; text: string; dedupeKey: string }];
    expect(call.toPhone).toBe(CAPTAIN);
    expect(call.text).toContain("Owner Ambika Mago");
    await alertOpsOfInboundText(db, { workspaceId: "ws-amb", managerId: "amb", fromPhone: "+15105791976", body: "can you send my statement?", messageSid: "SM1", onPropLaneLine: false });
    expect((sendFromService.mock.calls[1]![1] as { dedupeKey: string }).dedupeKey).toBe(call.dedupeKey);
  });
  it("a stranger on the PropLane line with no workspace goes to PropLane's admin phone only; a text from that admin's own phone is not an alert", async () => {
    const db = seed();
    expect(await alertOpsOfInboundText(db, { workspaceId: null, fromPhone: "+12065550188", body: "do you have rooms near UW", messageSid: "SM2", onPropLaneLine: true })).toBe("sent");
    expect((sendFromService.mock.calls[0]![1] as { toPhone: string }).toPhone).toBe(CAPTAIN);
    sendFromService.mockClear();
    expect(await alertOpsOfInboundText(db, { workspaceId: null, fromPhone: CAPTAIN, body: "test", messageSid: "SM3", onPropLaneLine: true })).toBe("skipped");
    expect(sendFromService).not.toHaveBeenCalled();
  });
  it("a text to a self-serve workspace's number is not PropLane's to alert", async () => {
    const db = createFakeDb({ portal_workspaces: [{ id: "ws-self", owner_user_id: "self", is_service: false }], workspace_work_number_recipients: [] }) as never;
    expect(await alertOpsOfInboundText(db, { workspaceId: "ws-self", managerId: "self", fromPhone: "+12065550188", body: "hello", messageSid: "SM4", onPropLaneLine: false })).toBe("skipped");
    expect(sendFromService).not.toHaveBeenCalled();
  });
});

describe("the 7 AM digest for managed workspaces", () => {
  it("one text per person: check-ins and check-outs, new leads (count, first names, house) and the reminder count, paid by the platform", async () => {
    const out = await runCheckinCheckoutDigest(seed(), { now: SEVEN });
    expect(out.serviceTexts).toBe(1);
    expect(alertPhones).not.toHaveBeenCalled(); // the managed house is not texted per house any more
    const [, call] = sendFromService.mock.calls[0]! as [unknown, { toPhone: string; text: string; dedupeKey: string; sendClass: string }];
    expect(call.toPhone).toBe(CAPTAIN);
    expect(call.sendClass).toBe("transactional");
    expect(call.text).toMatch(/^PropLane today:/);
    expect(call.text).toContain("check-in Room 4 (Anthony");
    expect(call.text).toContain("Check-out Room 7 (Kumaran");
    expect(call.text).toContain("New leads, last 24 hours: 3.");
    expect(call.text).toContain("Maria, Someone (5259 Brooklyn Ave)");
    expect(call.text).toContain("Payment reminders sent: 9 residents.");
    expect(call.text).not.toMatch(/code/i);
    expect(/^[\x20-\x7e\n]*$/.test(call.text)).toBe(true);
    // idempotent per day: a re-run keys the same text the same way
    sendFromService.mockClear();
    await runCheckinCheckoutDigest(seed(), { now: SEVEN });
    expect((sendFromService.mock.calls[0]![1] as { dedupeKey: string }).dedupeKey).toBe(call.dedupeKey);
  });

  it("a seat on this workspace gets the digest routine-class; a seat on another workspace gets nothing", async () => {
    const db = createFakeDb({
      portal_workspaces: [
        { id: "ws-amb", name: "1. Ambika", owner_user_id: "amb", is_service: true, is_default: true },
        { id: "ws-vin", name: "2. Vinod", owner_user_id: "vin", is_service: true, is_default: true },
      ],
      workspace_work_number_recipients: [],
      manager_property_records: [{ id: "p1", workspace_id: "ws-amb", manager_user_id: "amb", row_data: { address: "5259 Brooklyn Ave" }, property_data: {} }],
      account_link_invites: [
        { invitee_user_id: "seat-a", inviter_user_id: "amb", workspace_id: "ws-amb", team_role: "viewer", is_service_seat: true, status: "accepted" },
        { invitee_user_id: "seat-v", inviter_user_id: "vin", workspace_id: "ws-vin", team_role: "viewer", is_service_seat: true, status: "accepted" },
      ],
      profiles: [
        { id: "seat-a", email: "a@x.com", phone: "+12065550122", phone_verified_at: "2026-11-01T00:00:00Z", sms_forward_inbound: true, full_name: "A" },
        { id: "seat-v", email: "v@x.com", phone: "+12065550133", phone_verified_at: "2026-11-01T00:00:00Z", sms_forward_inbound: true, full_name: "V" },
      ],
      profile_roles: [], manager_sms_contacts: [], sms_unassigned_leads: [], payment_reminder_occurrences: [],
    }) as never;
    roster = [{ userId: "amb", isOwner: true, role: null }, { userId: "seat-a", isOwner: false, role: "viewer" }];
    await runCheckinCheckoutDigest(db, { now: SEVEN });
    const calls = sendFromService.mock.calls.map((c) => c[1] as { toPhone: string; sendClass: string });
    expect(calls.map((c) => c.toPhone)).toEqual(["+12065550122"]);
    expect(calls[0]!.sendClass).toBe("automated");
  });

  it("composes nothing when there is nothing to say, splits a long digest on line boundaries, and shows +N more leads", () => {
    expect(composeServiceDigest({ houseLines: [], leads: [] })).toEqual([]);
    const lines = Array.from({ length: 12 }, (_, i) => `Today House ${i} - check-in Room ${i} (Guest, 3 PM).`);
    const parts = composeServiceDigest({ houseLines: lines, leads: [] });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 450)).toBe(true);
    expect(parts.flatMap((p) => p.split("\n")).filter((l) => l.startsWith("Today")).length).toBe(12);
    expect(leadsDigestLine(Array.from({ length: 6 }, (_, i) => ({ firstName: `N${i}`, house: null })))).toContain("+2 more");
  });
});

describe("the owner is not a conversation until she texts", () => {
  const owner: ManagedOwnerIdentity = { ownerUserId: "amb", email: "ogambik2@gmail.com", phoneE164: "+15105791976" };
  const notice = { id: "t1", thread_type: "person", participant_email: "ogambik2@gmail.com", row_data: { email: "ogambik2@gmail.com", messages: [{ id: "m1", outbound: true, automated: true, body: "You approved Kumaran Chanthrakumar's application." }] } };
  it("hides a thread that holds only system notices", () => {
    expect(isSystemOnlyOwnerThread(notice, owner)).toBe(true);
  });
  it("shows it once the owner wrote in, or a person typed a reply, and never hides Assistant / Team / other people's threads", () => {
    const wrote = { ...notice, row_data: { ...notice.row_data, messages: [...notice.row_data.messages, { id: "m2", outbound: false, body: "thanks" }] } };
    expect(isSystemOnlyOwnerThread(wrote, owner)).toBe(false);
    const staffTyped = { ...notice, row_data: { ...notice.row_data, messages: [{ id: "m1", outbound: true, body: "Hi Ambika" }] } };
    expect(isSystemOnlyOwnerThread(staffTyped, owner)).toBe(false);
    expect(isSystemOnlyOwnerThread({ ...notice, thread_type: "agent_notice" }, owner)).toBe(false);
    expect(isSystemOnlyOwnerThread({ ...notice, id: "team-thread:amb:ws:ws-amb", thread_type: "team" }, owner)).toBe(false);
    expect(isSystemOnlyOwnerThread({ ...notice, participant_email: "someone@else.com", row_data: { messages: notice.row_data.messages } }, owner)).toBe(false);
  });
  it("an SMS conversation with the owner that never had an inbound text is hidden; one she started is not", () => {
    expect(isOutboundOnlyOwnerSms({ counterpartyUserId: "amb", phone: "+15105791976", lastInboundAt: null, lastInboundEventId: null }, owner)).toBe(true);
    expect(isOutboundOnlyOwnerSms({ counterpartyUserId: "amb", phone: "+15105791976", lastInboundAt: "2026-11-12T00:00:00Z", lastInboundEventId: "e1" }, owner)).toBe(false);
    expect(isOutboundOnlyOwnerSms({ counterpartyUserId: "x", phone: "+12065550101", lastInboundAt: null, lastInboundEventId: null }, owner)).toBe(false);
  });
});
