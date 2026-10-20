/**
 * Admin Communication places every text on the PropLane Service workspace the router stamped on it ("Unassigned" when
 * none), lists the open PropLane-line leads as read-only threads, and narrows by `workspaceId`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const SO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const WS_SVC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_SVC2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WS_OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

vi.mock("@/lib/claw-resident-messaging.server", () => ({ resolveMappedManagerContacts: async () => [] }));

import {
  ADMIN_SMS_UNASSIGNED_FILTER,
  fetchAdminSmsConversations,
  placeAdminSmsConversations,
} from "@/lib/manager-sms-messages.server";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

function inbound(id: string, owner: string, from: string, body: string, workspace: string | null, at = "2026-10-19T20:00:00Z") {
  return { id, manager_user_id: owner, from_phone: from, to_phone: "+12066781909", body, message_sid: `SM${id}`, matched_sender_user_id: null, counterparty_role: "prospect", conversation_key: null, created_at: at, workspace_id: workspace };
}

function withRange(base: ReturnType<typeof createMemoryDb>): ReturnType<typeof createMemoryDb> {
  return {
    ...base,
    from: (table: string) => {
      const builder = base.from(table) as unknown as Record<string, unknown>;
      builder.range = () => builder;
      return builder as never;
    },
  };
}

let db: ReturnType<typeof createMemoryDb>;
const run = (options?: Parameters<typeof fetchAdminSmsConversations>[1]) => fetchAdminSmsConversations(withRange(db) as never, options);
const bodies = (payload: Awaited<ReturnType<typeof run>>) =>
  payload.residents.flatMap((r) => r.messages.map((m) => m.body)).sort();

beforeEach(() => {
  db = createMemoryDb({
    platform_service_settings: [{ singleton: true, owner_user_id: SO }],
    portal_workspaces: [
      { id: WS_SVC, name: "1. Ambika", owner_user_id: CLIENT, is_default: true, is_service: true },
      { id: WS_SVC2, name: "2. Vinod", owner_user_id: SO, is_default: false, is_service: true },
      { id: WS_OTHER, name: "Ambika personal", owner_user_id: CLIENT, is_default: false, is_service: false },
    ],
    inbound_sms_log: [
      inbound("1", SO, "+12065550101", "line stranger", null),
      inbound("2", CLIENT, "+12065550102", "tour request for Ambika", WS_SVC),
      inbound("3", CLIENT, "+12065550103", "personal workspace text", WS_OTHER),
      inbound("4", SO, "+12065550104", "prospect routed to Vinod", WS_SVC2),
      inbound("5", SO, "+12065550105", "stamped with a non-service workspace", WS_OTHER),
    ],
    profiles: [{ id: SO, sms_from_number: "+12066781909" }],
    sms_unassigned_leads: [
      { id: "lead-1", phone_key: "2065550199", status: "open", profile: {}, last_inbound_at: "2026-10-19T21:00:00Z", updated_at: "2026-10-19T21:00:00Z" },
      { id: "lead-2", phone_key: "2065550188", status: "assigned", profile: {}, last_inbound_at: "2026-10-19T21:30:00Z", updated_at: "2026-10-19T21:30:00Z" },
    ],
    sms_unassigned_lead_turns: [
      { id: "t1", lead_id: "lead-1", direction: "inbound", body: "hi, any rooms near UW?", created_at: "2026-10-19T21:00:00Z" },
      { id: "t2", lead_id: "lead-1", direction: "outbound", body: "PropLane here. What is your budget?", created_at: "2026-10-19T21:00:05Z" },
    ],
  });
});

describe("workspace stamping on admin text threads", () => {
  it("puts each thread on the service workspace it was routed to, and the rest on Unassigned", async () => {
    const payload = await run();
    const byBody = new Map(payload.residents.map((r) => [r.messages[0]?.body, r]));
    expect(byBody.get("tour request for Ambika")).toMatchObject({ workspaceId: WS_SVC, workspaceName: "1. Ambika" });
    expect(byBody.get("prospect routed to Vinod")).toMatchObject({ workspaceId: WS_SVC2, workspaceName: "2. Vinod" });
    expect(byBody.get("line stranger")).toMatchObject({ workspaceId: null, workspaceName: null });
    // A stamp on a workspace that is not a service workspace is never named.
    expect(byBody.get("stamped with a non-service workspace")).toMatchObject({ workspaceId: null, workspaceName: null });
  });

  it("lists every service workspace for the filter, by name", async () => {
    const payload = await run();
    expect(payload.workspaces).toEqual([
      { id: WS_SVC, name: "1. Ambika" },
      { id: WS_SVC2, name: "2. Vinod" },
    ]);
  });

  it("still never shows the client's other workspace", async () => {
    expect(bodies(await run())).not.toContain("personal workspace text");
  });
});

describe("the workspace filter", () => {
  it("narrows to one service workspace", async () => {
    expect(bodies(await run({ workspaceId: WS_SVC }))).toEqual(["tour request for Ambika"]);
    expect(bodies(await run({ workspaceId: WS_SVC2 }))).toEqual(["prospect routed to Vinod"]);
  });

  it("'unassigned' keeps only the texts no service workspace holds", async () => {
    expect(bodies(await run({ workspaceId: ADMIN_SMS_UNASSIGNED_FILTER }))).toEqual(["line stranger", "stamped with a non-service workspace"]);
  });

  it("still names every workspace while filtered, so the field can switch back", async () => {
    expect((await run({ workspaceId: WS_SVC })).workspaces).toHaveLength(2);
  });
});

describe("PropLane-line leads in admin Communication", () => {
  it("adds each open lead as a read-only thread with a masked number, only when asked", async () => {
    expect((await run()).residents.some((r) => r.unassignedLeadId)).toBe(false);
    const payload = await run({ includeLeads: true });
    const leads = payload.residents.filter((r) => r.unassignedLeadId);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      unassignedLeadId: "lead-1",
      conversationKey: "lead:lead-1",
      name: "Lead •••• 0199",
      phone: null,
      workspaceId: null,
      counterpartyRole: "prospect",
    });
    expect(leads[0]!.messages.map((m) => [m.direction, m.body])).toEqual([
      ["inbound", "hi, any rooms near UW?"],
      ["outbound", "PropLane here. What is your budget?"],
    ]);
    // The number is never in the payload; a lead that was already assigned is not listed.
    expect(JSON.stringify(payload)).not.toContain("2065550199");
    expect(payload.residents.some((r) => r.unassignedLeadId === "lead-2")).toBe(false);
  });

  it("a lead is Unassigned: in the 'unassigned' filter, out of every workspace's", async () => {
    expect((await run({ includeLeads: true, workspaceId: ADMIN_SMS_UNASSIGNED_FILTER })).residents.some((r) => r.unassignedLeadId)).toBe(true);
    expect((await run({ includeLeads: true, workspaceId: WS_SVC })).residents.some((r) => r.unassignedLeadId)).toBe(false);
  });
});

describe("placeAdminSmsConversations", () => {
  const row = (workspaceId: string | null | undefined, at: string): ManagerSmsResidentConversation => ({
    residentUserId: null,
    residentEmail: null,
    name: at,
    phone: null,
    propertyLabel: null,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    messages: [{ id: at, direction: "inbound", body: at, fromPhone: null, toPhone: "", messageSid: null, source: "work_number", createdAt: at }],
  });

  it("orders newest first across rows and leads", () => {
    const out = placeAdminSmsConversations(
      { workNumber: null, personalPhone: null, phoneVerified: false, forwardInbound: true, smsConfigured: false, residents: [row(WS_SVC, "2026-10-19T10:00:00Z")] },
      { names: new Map([[WS_SVC, "A"]]), leads: [row(null, "2026-10-19T11:00:00Z")], workspaceId: null },
    );
    expect(out.residents.map((r) => r.name)).toEqual(["2026-10-19T11:00:00Z", "2026-10-19T10:00:00Z"]);
  });
});
