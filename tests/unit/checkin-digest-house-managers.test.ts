import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

const sendFromService = vi.fn(async (..._a: unknown[]) => ({ ok: true as const }) as { ok: true } | { ok: false; reason: string });
vi.mock("@/lib/service/service-manager.server", () => ({
  sendTextFromServiceOwner: (...a: unknown[]) => sendFromService(...a),
  readServiceManagerSettings: async () => null,
}));
const sendFromWorkNumber = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean; error?: string; durablyAccepted?: boolean });
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: (...a: unknown[]) => sendFromWorkNumber(...a) }));
vi.mock("@/lib/service/service-catalog.server", () => ({ readPlatformServiceOwnerId: async () => "svc-owner" }));
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: async () => ({ status: "sent" }) }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: async () => ({ delivered: true }) }));
const alertPhones = vi.fn(async (..._a: unknown[]) => ({ texted: 1, emailed: 0 }));
vi.mock("@/lib/one-number/ops-alerts.server", () => ({ alertPhonesOf: (...a: unknown[]) => alertPhones(...a) }));
type Entry = { source: string; propertyId: string; propertyLabel: string; roomId: string; roomLabel: string; summary: string; start: string; end: string };
let entries: Entry[] = [];
vi.mock("@/lib/occupancy/snapshot.server", () => ({
  occupancyEntriesForManager: async (_db: unknown, _owner: string, opts: { propertyIds: string[] }) => ({
    entries: entries.filter((e) => opts.propertyIds.includes(e.propertyId)),
  }),
}));
vi.mock("@/lib/bookings/property-stay-times.server", () => ({
  propertyStayClockFromRecord: () => ({ times: { checkInTime: "15:00", checkOutTime: "11:00" }, timeZone: "America/Los_Angeles" }),
}));

import { runCheckinCheckoutDigest } from "@/lib/one-number/checkin-digest.server";
import { addHouseLineToRecipients, usableProfilePhone, type HouseDigestBucket } from "@/lib/one-number/house-digest-recipients";

const ADMIN = "+15103098345"; // PropLane's own phone: listed "Also notify" on the managed workspace
const OWNER = "+15105791976"; // the owner of record's verified profile phone
const PM = "+12065550122"; // a co-manager on 4709A only
const SEVEN = () => new Date("2026-11-12T15:00:00Z"); // 7 AM PST
const VERIFIED = "2026-11-01T00:00:00Z";

const TODAY: Entry[] = [
  { source: "airbnb", propertyId: "p1", propertyLabel: "5259", roomId: "r4", roomLabel: "Room 4", summary: "Anthony", start: "2026-11-12", end: "2026-11-14" },
  { source: "airbnb", propertyId: "p2", propertyLabel: "4709A", roomId: "r7", roomLabel: "Room 7", summary: "Kumaran", start: "2026-11-09", end: "2026-11-11" },
];

function managedDb(extra: { invites?: Record<string, unknown>[]; profiles?: Record<string, unknown>[] } = {}) {
  return createFakeDb({
    portal_workspaces: [{ id: "ws-amb", name: "1. Ambika", owner_user_id: "amb", is_service: true, is_default: true }],
    workspace_work_number_recipients: [{ id: "r1", owner_user_id: "amb", label: "PropLane admin", phone: ADMIN, email: null, created_at: "2026-11-04T01:18:09Z" }],
    manager_property_records: [
      { id: "p1", workspace_id: "ws-amb", manager_user_id: "amb", row_data: { address: "5259 Brooklyn Ave" }, property_data: {} },
      { id: "p2", workspace_id: "ws-amb", manager_user_id: "amb", row_data: { address: "4709A 8th Ave" }, property_data: {} },
    ],
    account_link_invites: [
      // PropLane's admin account: an admin seat on every house, the SAME phone as the listed admin number.
      { invitee_user_id: "cap", inviter_user_id: "amb", workspace_id: "ws-amb", team_role: "admin", house_scope: "all", assigned_property_ids: ["p1", "p2"], is_service_seat: false, status: "accepted" },
      // A property manager who holds 4709A only.
      { invitee_user_id: "pm", inviter_user_id: "amb", workspace_id: "ws-amb", team_role: "property_manager", house_scope: "selected", assigned_property_ids: ["p2"], co_manager_permissions: { calendar: { read: true, edit: true } }, status: "accepted" },
      ...(extra.invites ?? []),
    ],
    profiles: [
      { id: "cap", email: "c@x.com", phone: ADMIN, phone_verified_at: VERIFIED, sms_forward_inbound: true, full_name: "Prakrit" },
      { id: "amb", email: "a@x.com", phone: OWNER, phone_verified_at: VERIFIED, sms_forward_inbound: true, full_name: "Ambika Mago" },
      { id: "pm", email: "pm@x.com", phone: PM, phone_verified_at: VERIFIED, sms_forward_inbound: true, full_name: "PM" },
      ...(extra.profiles ?? []),
    ],
    profile_roles: [],
    manager_sms_contacts: [],
    sms_unassigned_leads: [],
    payment_reminder_occurrences: [],
  }) as never;
}

const serviceCalls = () => sendFromService.mock.calls.map((c) => c[1] as { toPhone: string; text: string; dedupeKey: string; sendClass: string; recipientUserId: string | null });

beforeEach(() => {
  vi.clearAllMocks();
  sendFromService.mockResolvedValue({ ok: true });
  sendFromWorkNumber.mockResolvedValue({ ok: true });
  entries = [...TODAY];
});

describe("the 7 AM digest reaches every manager on the house, from the PropLane line", () => {
  it("the owner of record AND PropLane's admin each get one text with both houses", async () => {
    const out = await runCheckinCheckoutDigest(managedDb(), { now: SEVEN });
    const calls = serviceCalls();
    const admin = calls.filter((c) => c.toPhone === ADMIN);
    const owner = calls.filter((c) => c.toPhone === OWNER);
    // The admin's listed phone and the admin's own seat are the same number: ONE text.
    expect(admin).toHaveLength(1);
    expect(owner).toHaveLength(1);
    for (const text of [admin[0]!.text, owner[0]!.text]) {
      expect(text).toMatch(/^PropLane today:/);
      expect(text).toContain("Today 5259");
      expect(text).toContain("Today 4709A");
    }
    expect(owner[0]!.recipientUserId).toBe("amb"); // consent reads her verified profile phone
    expect(admin[0]!.recipientUserId).toBeNull(); // a listed number's consent is its listing
    expect(calls.every((c) => c.sendClass === "transactional")).toBe(true);
    expect(alertPhones).not.toHaveBeenCalled();
    expect(sendFromWorkNumber).not.toHaveBeenCalled(); // never the client's own number or wallet
    expect(out.serviceTexts).toBe(calls.length);
  });

  it("a co-manager on only one of the two houses gets only that house", async () => {
    await runCheckinCheckoutDigest(managedDb(), { now: SEVEN });
    const pm = serviceCalls().filter((c) => c.toPhone === PM);
    expect(pm).toHaveLength(1);
    expect(pm[0]!.text).toContain("Today 4709A");
    expect(pm[0]!.text).not.toContain("5259");
    expect(pm[0]!.recipientUserId).toBe("pm");
  });

  it("a phone shared across houses and people gets one text a day, keyed the same on a re-run", async () => {
    await runCheckinCheckoutDigest(managedDb(), { now: SEVEN });
    const first = serviceCalls();
    const phones = first.map((c) => c.toPhone);
    expect(new Set(phones).size).toBe(phones.length);
    expect(phones.sort()).toEqual([PM, ADMIN, OWNER].sort());
    sendFromService.mockClear();
    await runCheckinCheckoutDigest(managedDb(), { now: SEVEN });
    expect(serviceCalls().map((c) => c.dedupeKey).sort()).toEqual(first.map((c) => c.dedupeKey).sort());
  });

  it("skips a manager with no usable phone (unverified, or forwarding off) and logs only a count", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const db = managedDb({
      invites: [
        { invitee_user_id: "nov", inviter_user_id: "amb", workspace_id: "ws-amb", team_role: "property_manager", house_scope: "all", assigned_property_ids: ["p1", "p2"], co_manager_permissions: { calendar: { read: true, edit: true } }, status: "accepted" },
        { invitee_user_id: "off", inviter_user_id: "amb", workspace_id: "ws-amb", team_role: "property_manager", house_scope: "all", assigned_property_ids: ["p1", "p2"], co_manager_permissions: { calendar: { read: true, edit: true } }, status: "accepted" },
      ],
      profiles: [
        { id: "nov", email: "n@x.com", phone: "+12065550144", phone_verified_at: null, full_name: "Unverified Person" },
        { id: "off", email: "o@x.com", phone: "+12065550155", phone_verified_at: VERIFIED, sms_forward_inbound: false, full_name: "Forwarding Off" },
      ],
    });
    const out = await runCheckinCheckoutDigest(db, { now: SEVEN });
    const phones = serviceCalls().map((c) => c.toPhone);
    expect(phones).not.toContain("+12065550144");
    expect(phones).not.toContain("+12065550155");
    expect(out.skippedNoPhone).toBe(2);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("2065550144");
    expect(logged).not.toContain("Unverified");
    info.mockRestore();
  });

  it("a day with no check-ins or check-outs sends nothing at all (no empty or 'nothing today' text)", async () => {
    entries = [{ ...TODAY[0]!, start: "2026-11-20", end: "2026-11-22" }];
    const out = await runCheckinCheckoutDigest(managedDb(), { now: SEVEN });
    expect(sendFromService).not.toHaveBeenCalled();
    expect(sendFromWorkNumber).not.toHaveBeenCalled();
    expect(out.serviceTexts).toBe(0);
  });
});

describe("self-serve houses: the co-managers get it too, the owner is not texted twice", () => {
  function selfServeDb() {
    return createFakeDb({
      portal_workspaces: [{ id: "ws-self", name: "Self", owner_user_id: "self", is_service: false, is_default: true }],
      // The owner listed their own phone: it keeps the per-house text from alertPhonesOf.
      workspace_work_number_recipients: [{ id: "r9", owner_user_id: "self", label: "Me", phone: "+12065550100", email: null, created_at: "2026-11-01T00:00:00Z" }],
      manager_property_records: [
        { id: "p1", workspace_id: "ws-self", manager_user_id: "self", row_data: { address: "5259 Brooklyn Ave" }, property_data: {} },
        { id: "p2", workspace_id: "ws-self", manager_user_id: "self", row_data: { address: "4709A 8th Ave" }, property_data: {} },
      ],
      account_link_invites: [
        { invitee_user_id: "cm", inviter_user_id: "self", workspace_id: "ws-self", team_role: "property_manager", house_scope: "selected", assigned_property_ids: ["p1"], co_manager_permissions: { calendar: { read: true, edit: true } }, status: "accepted" },
        // A teammate whose phone is the owner's listed number: already texted, not again.
        { invitee_user_id: "dup", inviter_user_id: "self", workspace_id: "ws-self", team_role: "admin", house_scope: "all", assigned_property_ids: ["p1", "p2"], status: "accepted" },
      ],
      profiles: [
        { id: "self", email: "s@x.com", phone: "+12065550199", phone_verified_at: VERIFIED, sms_forward_inbound: true, full_name: "Owner" },
        { id: "cm", email: "cm@x.com", phone: "+12065550111", phone_verified_at: VERIFIED, sms_forward_inbound: true, full_name: "CM" },
        { id: "dup", email: "d@x.com", phone: "+12065550100", phone_verified_at: VERIFIED, sms_forward_inbound: true, full_name: "Dup" },
      ],
      profile_roles: [],
    }) as never;
  }

  it("listed phones keep the per-house text; a co-manager gets one combined text of their houses from the workspace's own number", async () => {
    const out = await runCheckinCheckoutDigest(selfServeDb(), { now: SEVEN });
    expect(alertPhones).toHaveBeenCalledTimes(2);
    expect(sendFromService).not.toHaveBeenCalled(); // not PropLane's line or wallet
    const calls = sendFromWorkNumber.mock.calls.map((c) => c[0] as { managerUserId: string; workspaceId: string; to: string; text: string; purpose: string; recipientUserId: string; sendClass: string });
    expect(calls.map((c) => c.to)).toEqual(["+12065550111"]);
    expect(calls[0]).toMatchObject({ managerUserId: "self", workspaceId: "ws-self", purpose: "team_notice", recipientUserId: "cm", sendClass: "transactional" });
    expect(calls[0]!.text).toContain("Today 5259");
    expect(calls[0]!.text).not.toContain("4709A");
    expect(out.managerTexts).toBe(1);
  });
});

describe("house-digest-recipients (pure)", () => {
  it("folds houses per normalized phone and never repeats a house", () => {
    const buckets = new Map<string, HouseDigestBucket>();
    addHouseLineToRecipients(buckets, { propertyId: "p1", text: "Today A — check-in Room 1." }, [{ phone: "(206) 555-0111", userId: "u", sendClass: "transactional" }]);
    addHouseLineToRecipients(buckets, { propertyId: "p1", text: "Today A — check-in Room 1." }, [{ phone: "+12065550111", userId: "u", sendClass: "transactional" }]);
    addHouseLineToRecipients(buckets, { propertyId: "p2", text: "Today B — check-out Room 2." }, [{ phone: "+1 206 555 0111", userId: "u", sendClass: "transactional" }]);
    addHouseLineToRecipients(buckets, { propertyId: "p3", text: "" }, [{ phone: "+12065550111", userId: "u", sendClass: "transactional" }]);
    expect([...buckets.values()]).toEqual([
      { phone: "+12065550111", userId: "u", sendClass: "transactional", houseLines: ["Today A — check-in Room 1.", "Today B — check-out Room 2."], propertyIds: ["p1", "p2"] },
    ]);
  });
  it("a profile phone counts only when verified and forwarding is not off", () => {
    expect(usableProfilePhone({ phone: "2065550111", phone_verified_at: VERIFIED })).toBe("+12065550111");
    expect(usableProfilePhone({ phone: "2065550111", phone_verified_at: null })).toBeNull();
    expect(usableProfilePhone({ phone: "2065550111", phone_verified_at: VERIFIED, sms_forward_inbound: false })).toBeNull();
    expect(usableProfilePhone({ phone: "", phone_verified_at: VERIFIED })).toBeNull();
  });
});
