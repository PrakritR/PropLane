import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb } from "../helpers/fake-table-db";

const enqueueOwnerSms = vi.fn(async (_input: Record<string, unknown>, _db?: unknown) => ({
  ok: true as const, outboxId: "o1", status: "queued", deduplicated: false,
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: (input: Record<string, unknown>, db?: unknown) => enqueueOwnerSms(input, db),
}));
const resolveWorkspaceSendLine = vi.fn(async (..._a: unknown[]): Promise<{ phoneNumber: string; numberId: string | null } | null> => ({
  phoneNumber: "+15005550001", numberId: "line-1",
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: (...a: unknown[]) => resolveWorkspaceSendLine(...a),
}));
const stopped = new Set<string>();
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async (_d: unknown, p: string) => stopped.has(p) }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: vi.fn() }));

import { forwardInboundToTeammates, resolveResidentForwardHouseId } from "@/lib/sms/inbound-forward-team.server";

const OWNER = "owner-1";
const WS = "ws-1";
const HOUSE = "house-5257";
const verified = "2026-10-01T00:00:00.000Z";
const RESIDENT_PHONE = "+12065559999";

function seed() {
  return createFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: OWNER, is_default: true, name: "Seattle" }],
    account_link_invites: [
      { inviter_user_id: OWNER, invitee_user_id: "with-house", status: "accepted", workspace_id: WS, team_role: "admin",
        assigned_property_ids: [HOUSE], property_co_manager_permissions: { [HOUSE]: { inbox: true } } },
      { inviter_user_id: OWNER, invitee_user_id: "other-house", status: "accepted", workspace_id: WS, team_role: "admin",
        assigned_property_ids: ["house-x"], property_co_manager_permissions: { "house-x": { inbox: true } } },
      { inviter_user_id: OWNER, invitee_user_id: "stopped", status: "accepted", workspace_id: WS, team_role: "admin",
        assigned_property_ids: [HOUSE], property_co_manager_permissions: { [HOUSE]: { inbox: true } } },
      { inviter_user_id: OWNER, invitee_user_id: "no-module", status: "accepted", workspace_id: WS, team_role: "admin",
        assigned_property_ids: [HOUSE], property_co_manager_permissions: { [HOUSE]: { payments: true } } },
    ],
    profiles: [
      { id: OWNER, full_name: "Ambika", phone: "+12065550100", phone_verified_at: verified },
      { id: "with-house", full_name: "Prakrit", phone: "+12065550101", phone_verified_at: verified },
      { id: "other-house", full_name: "Akshaya", phone: "+12065550102", phone_verified_at: verified },
      { id: "stopped", full_name: "Sam", phone: "+12065550103", phone_verified_at: verified },
      { id: "no-module", full_name: "Nia", phone: "+12065550104", phone_verified_at: verified },
    ],
    manager_sms_messages: [{ manager_user_id: OWNER, resident_phone: RESIDENT_PHONE, resident_user_id: "res-1" }],
    sms_outbox: [],
    portal_lease_pipeline_records: [],
  });
}

const run = (db: SupabaseClient, over: Record<string, unknown> = {}) =>
  forwardInboundToTeammates(db, {
    managerUserId: OWNER, workspaceId: WS, houseId: HOUSE, fromPhone: RESIDENT_PHONE,
    body: "The sink is leaking", messageSid: "SM1", ...over,
  } as Parameters<typeof forwardInboundToTeammates>[1]);

beforeEach(() => {
  vi.clearAllMocks();
  enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: "o1", status: "queued", deduplicated: false });
  resolveWorkspaceSendLine.mockResolvedValue({ phoneNumber: "+15005550001", numberId: "line-1" });
  stopped.clear();
});

describe("forwardInboundToTeammates", () => {
  it("a resident with a house: the teammate WITH that house gets it from the work number, billed to the owner, 'fwd:<sid>:<member>'; the one without does not", async () => {
    const fake = seed();
    fake.tables.profiles!.push({ id: "res-1", full_name: "Aaron" });
    const outcomes = await run(fake as unknown as SupabaseClient);
    expect(outcomes.filter((o) => o.status === "sent").map((o) => o.memberUserId).sort()).toEqual(["stopped", "with-house"]);
    const tos = enqueueOwnerSms.mock.calls.map(([i]) => i.recipientUserId);
    expect(tos).not.toContain("other-house"); // another house
    expect(tos).not.toContain("no-module"); // no Communication on this house
    expect(tos).not.toContain(OWNER); // the owner has the existing forward
    const first = enqueueOwnerSms.mock.calls.find(([i]) => i.recipientUserId === "with-house")![0];
    expect(first).toMatchObject({
      managerUserId: OWNER, selectedWorkLineId: "line-1", purpose: "team_inbound_forward",
      dedupeKey: "fwd:SM1:with-house", body: "Aaron: The sink is leaking", propertyId: HOUSE,
    });
    expect(String(first.body)).not.toContain("2065559999"); // never the raw number
  });

  it("an unresolved house is owner-only: nothing goes to teammates", async () => {
    expect(await run(seed() as unknown as SupabaseClient, { houseId: null })).toEqual([]);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("no MessageSid (nothing to dedupe on) or no sendable line: no teammate texts", async () => {
    expect(await run(seed() as unknown as SupabaseClient, { messageSid: null })).toEqual([]);
    resolveWorkspaceSendLine.mockResolvedValueOnce(null);
    expect(await run(seed() as unknown as SupabaseClient)).toEqual([]);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("a STOPped, unverified or forwarding-off teammate is skipped, the rest still go", async () => {
    const fake = seed();
    stopped.add("+12065550103");
    const outcomes = await run(fake as unknown as SupabaseClient);
    expect(outcomes.find((o) => o.memberUserId === "stopped")).toMatchObject({ status: "skipped", reason: "stop" });
    expect(outcomes.find((o) => o.memberUserId === "with-house")?.status).toBe("sent");
    fake.tables.profiles!.find((p) => p.id === "with-house")!.sms_forward_inbound = false;
    const again = await run(fake as unknown as SupabaseClient, { messageSid: "SM2" });
    expect(again.find((o) => o.memberUserId === "with-house")).toMatchObject({ status: "skipped", reason: "member_opted_out_of_texts" });
  });

  it("a replayed MessageSid forwards once: the same dedupe key both times", async () => {
    const fake = seed();
    await run(fake as unknown as SupabaseClient);
    await run(fake as unknown as SupabaseClient);
    const keys = enqueueOwnerSms.mock.calls.filter(([i]) => i.recipientUserId === "with-house").map(([i]) => i.dedupeKey);
    expect(keys).toEqual(["fwd:SM1:with-house", "fwd:SM1:with-house"]); // the outbox's unique (owner, key) makes the second a no-op
  });

  it("counts against the same hourly cap as the chat relay", async () => {
    const fake = seed();
    for (let i = 0; i < 59; i += 1) {
      fake.tables.sms_outbox!.push({ id: `c${i}`, manager_user_id: OWNER, purpose: i % 2 ? "team_chat_relay" : "team_inbound_forward", selected_work_line_id: "line-1", created_at: new Date().toISOString() });
    }
    const outcomes = await run(fake as unknown as SupabaseClient);
    expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(1);
    expect(outcomes.some((o) => o.reason === "hourly_cap")).toBe(true);
  });

  it("never texts the texter's own number", async () => {
    const fake = seed();
    fake.tables.profiles!.find((p) => p.id === "with-house")!.phone = RESIDENT_PHONE;
    const outcomes = await run(fake as unknown as SupabaseClient);
    expect(outcomes.find((o) => o.memberUserId === "with-house")).toMatchObject({ status: "skipped", reason: "is_sender" });
  });
});

describe("resolveResidentForwardHouseId", () => {
  const lease = (propertyId: unknown, status = "Active") => ({ manager_user_id: OWNER, resident_email: "aaron@example.com", row_data: { propertyId, status } });
  const withLeases = (rows: unknown[]) => {
    const fake = seed();
    fake.tables.portal_lease_pipeline_records = rows as never;
    return fake as unknown as SupabaseClient;
  };

  it("one house across the resident's leases is the house; voided leases are ignored", async () => {
    const db = withLeases([lease(HOUSE), lease("old-house", "Voided")]);
    expect(await resolveResidentForwardHouseId(db, { ownerManagerUserId: OWNER, residentEmail: "Aaron@Example.com" })).toBe(HOUSE);
  });

  it("several houses, a lease with no house, no lease or no email is unknown (owner only)", async () => {
    expect(await resolveResidentForwardHouseId(withLeases([lease(HOUSE), lease("b")]), { ownerManagerUserId: OWNER, residentEmail: "aaron@example.com" })).toBeNull();
    expect(await resolveResidentForwardHouseId(withLeases([lease(HOUSE), lease("")]), { ownerManagerUserId: OWNER, residentEmail: "aaron@example.com" })).toBeNull();
    expect(await resolveResidentForwardHouseId(withLeases([]), { ownerManagerUserId: OWNER, residentEmail: "aaron@example.com" })).toBeNull();
    expect(await resolveResidentForwardHouseId(withLeases([lease(HOUSE)]), { ownerManagerUserId: OWNER, residentEmail: "" })).toBeNull();
  });
});
