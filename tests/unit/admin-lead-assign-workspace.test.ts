/**
 * Admin Communication's "Assign to a workspace" for a PropLane-line lead: the same assignment path the prospect's own
 * pick takes (history copied into the workspace owner's prospect conversation, one alert, the phone's session moved),
 * but with no house, only for a PropLane Service workspace, and with one audit row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEAD_CONSTRAINTS, leadFakeDb, type LeadFakeDb } from "../helpers/lead-fake-db";

const mocks = vi.hoisted(() => ({
  log: vi.fn(async (..._args: unknown[]) => true),
  alert: vi.fn(async (..._args: unknown[]) => ({ sent: true })),
  contact: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/lead-extract.server", () => ({ extractLeadFieldsWithModel: vi.fn(async () => null) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: (...args: unknown[]) => mocks.log(...args) }));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({ upsertManagerSmsContact: (...args: unknown[]) => mocks.contact(...args) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: (...args: unknown[]) => mocks.alert(...args) }));

import { assignLeadToHouse, listOpenLeadThreads } from "@/lib/one-number/unassigned-leads.server";

const WS_SVC = "11111111-1111-4111-8111-111111111111";
const WS_PLAIN = "22222222-2222-4222-8222-222222222222";
const OWNER_SVC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_PLAIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function seed(): LeadFakeDb {
  return leadFakeDb(
    {
      sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: "+12065550100" }],
      portal_workspaces: [
        { id: WS_SVC, name: "1. Ambika", owner_user_id: OWNER_SVC, is_default: true, is_service: true },
        { id: WS_PLAIN, name: "Not managed", owner_user_id: OWNER_PLAIN, is_default: true, is_service: false },
      ],
      sms_unassigned_leads: [
        { id: "lead-1", phone_key: "2065550142", status: "open", profile: { stage: "qualifying" }, last_inbound_at: "2026-10-19T20:00:00Z", updated_at: "2026-10-19T20:00:00Z" },
      ],
      sms_unassigned_lead_turns: [
        { id: "t1", lead_id: "lead-1", direction: "inbound", body: "any rooms?", created_at: "2026-10-19T20:00:00Z" },
        { id: "t2", lead_id: "lead-1", direction: "outbound", body: "What is your budget?", created_at: "2026-10-19T20:00:05Z" },
      ],
    },
    { constraints: LEAD_CONSTRAINTS },
  );
}

beforeEach(() => {
  mocks.log.mockClear();
  mocks.alert.mockClear();
  mocks.contact.mockClear();
});

describe("assigning a lead straight to a service workspace", () => {
  it("copies the conversation to the workspace owner's prospect thread, alerts that team once, moves the session", async () => {
    const fake = seed();
    const result = await assignLeadToHouse(fake.db, { leadId: "lead-1", workspaceId: WS_SVC, by: "admin" });
    expect(result).toEqual({ ok: true, workspaceId: WS_SVC, ownerUserId: OWNER_SVC, label: "1. Ambika" });
    expect(mocks.log).toHaveBeenCalledTimes(2);
    for (const [, entry] of mocks.log.mock.calls as Array<[unknown, Record<string, unknown>]>) {
      expect(entry).toMatchObject({ managerUserId: OWNER_SVC, counterpartyRole: "prospect", workspaceId: WS_SVC, residentPhone: "+12065550142" });
    }
    expect(mocks.alert).toHaveBeenCalledOnce();
    expect(mocks.alert.mock.calls[0]![1]).toMatchObject({ workspaceId: WS_SVC, ownerUserId: OWNER_SVC, kind: "new_lead", propertyId: null });
    expect(fake.rows.sms_unassigned_leads![0]).toMatchObject({ status: "assigned", assigned_workspace_id: WS_SVC, assigned_property_id: null });
    expect(fake.rows.sms_line_sessions![0]).toMatchObject({ phone_key: "2065550142", current_workspace_id: WS_SVC, active_role: "prospect" });
  });

  it("refuses a workspace that is not a PropLane Service workspace, and leaves the lead open", async () => {
    const fake = seed();
    expect(await assignLeadToHouse(fake.db, { leadId: "lead-1", workspaceId: WS_PLAIN, by: "admin" })).toEqual({ ok: false, error: "workspace_not_found" });
    expect(await assignLeadToHouse(fake.db, { leadId: "lead-1", workspaceId: "99999999-9999-4999-8999-999999999999", by: "admin" })).toEqual({ ok: false, error: "workspace_not_found" });
    expect(fake.rows.sms_unassigned_leads![0]!.status).toBe("open");
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("a prospect's own pick can never name a workspace instead of a house", async () => {
    const fake = seed();
    expect(await assignLeadToHouse(fake.db, { leadId: "lead-1", workspaceId: WS_SVC, by: "prospect" })).toEqual({ ok: false, error: "house_not_found" });
    expect(fake.rows.sms_unassigned_leads![0]!.status).toBe("open");
  });

  it("assigns once", async () => {
    const fake = seed();
    await assignLeadToHouse(fake.db, { leadId: "lead-1", workspaceId: WS_SVC, by: "admin" });
    expect(await assignLeadToHouse(fake.db, { leadId: "lead-1", workspaceId: WS_SVC, by: "admin" })).toEqual({ ok: false, error: "lead_not_open" });
    expect(mocks.alert).toHaveBeenCalledOnce();
  });

  it("an assigned lead leaves the admin thread list", async () => {
    const fake = seed();
    expect((await listOpenLeadThreads(fake.db)).map((t) => t.leadId)).toEqual(["lead-1"]);
    await assignLeadToHouse(fake.db, { leadId: "lead-1", workspaceId: WS_SVC, by: "admin" });
    expect(await listOpenLeadThreads(fake.db)).toEqual([]);
  });
});
