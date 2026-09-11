import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { resolveManagerSmsAccess, resolveManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import { samePhone } from "@/lib/sms/manager-relay.server";
import { smsAccessAllowsRow } from "@/lib/sms/manager-sms-access";
import { getEffectiveManagerSmsEntitlement, getStoredManagerSmsEntitlement } from "@/lib/sms/manager-sms-entitlement.server";
import { ensureManagerInboundReplyConsent } from "@/lib/sms/manager-conversation-consent.server";
import { agentRegistry, buildManagerSmsRegistry } from "@/lib/tools";
import { scopeManagerTool } from "@/lib/tools/manager-co-manager-tool-scope";
import type { AgentContext } from "@/lib/tools/context";
import { z } from "zod";
import { isPureCoManagerWorkspace } from "@/lib/sms/manager-workspace-role.server";

const owner = "owner", co = "co", other = "co-two";
const ownerPhone = "+12065550101", coPhone = "+12065550102", otherPhone = "+12065550103";
const work = "+12065550999";
function seed() {
  return createMemoryDb({
    profiles: [
      { id: owner, email: "owner@unit.test", phone: ownerPhone, phone_verified_at: "2026-01-01" },
      { id: co, email: "co@unit.test", phone: coPhone, phone_verified_at: "2026-01-01" },
      { id: other, email: "other@unit.test", phone: otherPhone, phone_verified_at: "2026-01-01" },
    ],
    account_link_invites: [
      { inviter_user_id: owner, invitee_user_id: co, status: "accepted", assigned_property_ids: ["house-a"], property_co_manager_permissions: { "house-a": { services: { read: true }, inbox: { read: true, edit: true } } } },
      { inviter_user_id: owner, invitee_user_id: other, status: "accepted", assigned_property_ids: ["house-b"], property_co_manager_permissions: { "house-b": { payments: { read: true } } } },
    ],
    sms_manager_entitlements: [
      { manager_user_id: owner, tier: "pro", source: "stripe", status: "active", eligible: true },
      { manager_user_id: co, tier: "free", source: "none", status: "active", eligible: false },
    ],
  });
}

async function identity(db = seed(), actor = co, phone = actor === owner ? ownerPhone : actor === other ? otherPhone : coPhone, numberOwner = owner) {
  return resolveManagerSmsInboundIdentity(db as never, { workNumberOwnerId: numberOwner, fromPhone: phone, toPhone: work });
}

describe("manager + two co-managers texting work numbers", () => {
  it("retries unknown workspace routing instead of treating a lookup outage as an owning manager", async () => {
    const db = seed();
    const original = db.from.bind(db);
    vi.spyOn(db, "from").mockImplementation((table) => {
      const query = original(table);
      if (table === "manager_property_records") {
        query.limit = (() => Promise.resolve({ data: null, error: { message: "offline" } })) as never;
      }
      return query;
    });
    await expect(isPureCoManagerWorkspace(db as never, co)).resolves.toBe(false);
    await expect(isPureCoManagerWorkspace(db as never, co, { throwOnError: true })).rejects.toThrow("ownership unavailable");
  });
  it("recognizes all three people independently and limits each co-manager to their assignment", async () => {
    const db = seed();
    for (const [actor, phone, mode, numberOwner] of [
      [owner, ownerPhone, "owner", owner], [co, coPhone, "delegated", owner],
      [other, otherPhone, "delegated", owner], [co, coPhone, "combined", co],
    ]) {
      const found = await identity(db, actor, phone, numberOwner);
      expect(found).toMatchObject({ actorUserId: actor, workNumberOwnerId: numberOwner, access: { mode } });
    }
    expect(await identity(db, co, coPhone, other)).toBeNull();
  });

  it("does not confuse country codes or choose the owner when a cell is shared", async () => {
    expect(samePhone("(206) 555-0101", ownerPhone)).toBe(true);
    expect(samePhone("+442079460958", "+12079460958")).toBe(false);
    const db = seed();
    db.__tables.profiles[1].phone = ownerPhone;
    expect(await identity(db, owner, ownerPhone)).toBeNull();
  });

  it("requires the correct module as well as the property, and re-reads revocations", async () => {
    const db = seed();
    const access = (await identity(db))!.access;
    expect(smsAccessAllowsRow(access, { dataOwnerId: owner, table: "portal_work_order_records", rowData: { propertyId: "house-a" } })).toBe(true);
    expect(smsAccessAllowsRow(access, { dataOwnerId: owner, table: "portal_household_charge_records", rowData: { propertyId: "house-a" } })).toBe(false);
    expect(smsAccessAllowsRow(access, { dataOwnerId: owner, table: "portal_work_order_records", rowData: { propertyId: "house-b" } })).toBe(false);
    db.__tables.account_link_invites[0].property_co_manager_permissions = {};
    const denied = (await identity(db))!.access;
    expect(smsAccessAllowsRow(denied, { dataOwnerId: owner, table: "portal_work_order_records", rowData: { propertyId: "house-a" } })).toBe(false);
    db.__tables.account_link_invites[0].status = "cancelled";
    expect(await identity(db)).toBeNull();
  });

  it("inherits paid assistant-email eligibility without overwriting the co-manager's own billing state", async () => {
    const db = seed();
    expect(await getStoredManagerSmsEntitlement(db as never, co)).toMatchObject({ eligible: false });
    expect(await getEffectiveManagerSmsEntitlement(db as never, co, { preferPaid: true })).toMatchObject({ eligible: true });
    db.__tables.account_link_invites[0].status = "cancelled";
    expect(await getEffectiveManagerSmsEntitlement(db as never, co, { preferPaid: true })).toMatchObject({ eligible: false });
  });

  it("records reply consent for the exact owner + actor conversation, preserving revocation", async () => {
    const db = seed();
    const found = (await identity(db))!;
    expect(await ensureManagerInboundReplyConsent(db as never, found, "SM-first")).toBe("allowed");
    expect(db.__tables.sms_consent_events).toHaveLength(1);
    expect(db.__tables.sms_consent_events[0]).toMatchObject({ manager_user_id: owner, conversation_key: "owner:manager:co", purpose: "manager_conversation", event_type: "granted", evidence: { messageSid: "SM-first", actorUserId: co } });
    expect(await ensureManagerInboundReplyConsent(db as never, found, "SM-retry")).toBe("allowed");
    expect(db.__tables.sms_consent_events).toHaveLength(1);
    db.__tables.sms_consent_events[0].event_type = "revoked";
    expect(await ensureManagerInboundReplyConsent(db as never, found, "SM-next")).toBe("suppressed");
    expect(db.__tables.sms_consent_events).toHaveLength(1);
  });

  it("does not expose unaudited owner-wide writes on the manager's number", async () => {
    const access = (await identity())!.access;
    const registry = buildManagerSmsRegistry(access);
    expect(registry.has("send_message")).toBe(true);
    expect(registry.has("reply_to_thread")).toBe(true);
    expect(registry.has("create_charge")).toBe(false);
    const ctx = { managerSmsAccess: access, userId: co, landlordId: owner } as AgentContext;
    await expect(agentRegistry.get("create_charge")!.handler(ctx, {})).rejects.toThrow("not available");
    const combined = await resolveManagerSmsAccess(seed() as never, { actorUserId: co, workNumberOwnerId: co });
    const tool = scopeManagerTool({ name: "future_owner_tool", kind: "read", description: "test", inputSchema: z.object({}), handler: async (ctx: AgentContext) => ({ ownerId: ctx.landlordId, access: ctx.managerSmsAccess }) });
    expect(await tool.handler({ ...ctx, managerSmsAccess: combined! }, {})).toEqual({ ownerId: co, access: undefined });
  });
});
