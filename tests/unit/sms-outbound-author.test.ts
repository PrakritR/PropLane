/**
 * An AI or automated outbound text reads as the line's agent ("PropLane"), never as the workspace owner whose number sent
 * it; a staff member's own reply wears their own name. Display layer only: stored rows are never rewritten.
 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { isAutomatedSmsOutbound, smsBubbleSenderLabel, smsOutboundAuthorLabel, SMS_AGENT_AUTHOR_LABEL } from "@/lib/manager-sms-messages";

vi.mock("@/lib/claw-resident-messaging.server", () => ({ resolveMappedManagerContacts: async () => [] }));
import { fetchAdminSmsConversations } from "@/lib/manager-sms-messages.server";

const SO = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333"; // Ambika, the client who owns the managed workspace
const STAFF = "44444444-4444-4444-8444-444444444444";
const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESIDENT = "55555555-5555-4555-8555-555555555555";

describe("isAutomatedSmsOutbound", () => {
  it("a person's own conversation reply is not automated; every system purpose is", () => {
    expect(isAutomatedSmsOutbound({ purpose: "manager_conversation", sendClass: "transactional", actorUserId: STAFF })).toBe(false);
    expect(isAutomatedSmsOutbound({ purpose: "manager_agent_notification_leasing", sendClass: "transactional", actorUserId: OWNER })).toBe(true);
    expect(isAutomatedSmsOutbound({ purpose: "line_role_question" })).toBe(true);
    expect(isAutomatedSmsOutbound({ purpose: "manager_conversation", sendClass: "automated" })).toBe(true);
    expect(isAutomatedSmsOutbound({ source: "automated" })).toBe(true);
    // The agent answering on the texter's behalf is "actor = the texter": never a staff reply.
    expect(isAutomatedSmsOutbound({ purpose: "manager_conversation", actorUserId: RESIDENT, counterpartyUserId: RESIDENT })).toBe(true);
    expect(isAutomatedSmsOutbound({})).toBe(false);
  });
});

describe("the label an outbound text wears", () => {
  it("automated: PropLane, even when a person's name is attached; human: their own name; the viewer's own: You", () => {
    expect(smsOutboundAuthorLabel({ automated: true, sentBy: { userId: OWNER, name: "Ambika Mago" } })).toBe(SMS_AGENT_AUTHOR_LABEL);
    expect(smsOutboundAuthorLabel({ source: "automated" })).toBe("PropLane");
    expect(smsOutboundAuthorLabel({ sentBy: { userId: STAFF, name: "Dev Patel" } })).toBe("Dev Patel");
    expect(smsOutboundAuthorLabel({})).toBe("You");
    expect(smsBubbleSenderLabel({ direction: "outbound", automated: true, sentBy: { userId: OWNER, name: "Ambika Mago" } }, "Lead")).toBe("PropLane");
    expect(smsBubbleSenderLabel({ direction: "inbound" }, "Maria")).toBe("Maria");
  });
});

describe("admin Communication", () => {
  it("labels the agent's reply PropLane (not the owner) and a staff reply with the staff member's name", async () => {
    const outbound = (id: string, sid: string, body: string) => ({
      id, manager_user_id: SO, resident_user_id: null, resident_phone: "+12065550101", body, from_phone: "+12066781909", to_phone: "+12065550101",
      message_sid: sid, source: "work_number", created_at: id === "o1" ? "2026-11-12T10:00:00Z" : "2026-11-12T10:05:00Z", direction: "outbound",
      counterparty_role: "prospect", conversation_key: `${SO}:prospect:+12065550101`, workspace_id: WS,
    });
    const db = createMemoryDb({
      platform_service_settings: [{ singleton: true, owner_user_id: SO }],
      portal_workspaces: [{ id: WS, name: "1. Ambika", owner_user_id: OWNER, is_default: true, is_service: true }],
      profiles: [{ id: STAFF, full_name: "Dev Patel" }, { id: OWNER, full_name: "Ambika Mago" }],
      manager_sms_messages: [outbound("o1", "SMagent", "Room 4 is open Nov 1."), outbound("o2", "SMstaff", "I can show it Saturday.")],
      sms_outbox: [
        { provider_message_sid: "SMagent", manager_user_id: SO, actor_user_id: OWNER, purpose: "manager_agent_notification_leasing", send_class: "transactional" },
        { provider_message_sid: "SMstaff", manager_user_id: SO, actor_user_id: STAFF, purpose: "manager_conversation", send_class: "transactional" },
      ],
    });
    const withRange = { ...db, from: (t: string) => { const b = db.from(t) as unknown as Record<string, unknown>; b.range = () => b; return b as never; } };
    const payload = await fetchAdminSmsConversations(withRange as never, { workspaceId: WS });
    const messages = payload.residents.flatMap((r) => r.messages);
    const agent = messages.find((m) => m.messageSid === "SMagent")!;
    const staff = messages.find((m) => m.messageSid === "SMstaff")!;
    expect(smsOutboundAuthorLabel(agent)).toBe("PropLane");
    expect(JSON.stringify(agent)).not.toContain("Ambika Mago");
    expect(smsOutboundAuthorLabel(staff)).toBe("Dev Patel");
    // Display only: the stored rows are untouched.
    expect((db.__tables.manager_sms_messages as Array<Record<string, unknown>>).every((r) => !("automated" in r))).toBe(true);
  });
});
