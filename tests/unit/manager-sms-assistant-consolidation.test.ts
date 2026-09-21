import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergePersistedChatHistory } from "@/lib/agent/chat-handler";

const { sendFromManagerWorkNumber } = vi.hoisted(() => ({
  sendFromManagerWorkNumber: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber }));

describe("manager self-SMS assistant consolidation", () => {
  it("delivers the assistant reply without creating a Communication SMS row", async () => {
    const { deliverManagerSmsReply } = await import("@/lib/agent/manager-sms-agent.server");
    await deliverManagerSmsReply({
      managerUserId: "11111111-1111-4111-8111-111111111111",
      toPhone: "+12065550100",
      text: "Here is the answer.",
      workNumber: "+12065559000",
    });
    expect(sendFromManagerWorkNumber).toHaveBeenCalledWith(expect.objectContaining({
      counterpartyRole: "manager",
      purpose: "manager_conversation",
    }));
    expect(sendFromManagerWorkNumber).toHaveBeenCalledWith(expect.objectContaining({ skipLog: true }));
  });

  it("migrates old manager SMS transcripts and removes duplicate Communication rows", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260920120000_merge_manager_sms_into_portal_assistant.sql"), "utf8").toLowerCase();
    expect(sql).toContain("where session.kind = 'manager_sms'");
    expect(sql).toContain("where kind = 'portal_chat' and portal = 'manager'");
    expect(sql).toContain("update public.agent_messages");
    expect(sql).toContain("update public.agent_pending_actions");
    expect(sql).toContain("update public.sms_inbound_receipts");
    expect(sql).toMatch(/set[\s\S]*kind = 'portal_chat'/);
    expect(sql).toContain("message.source_message_sid = inbound.message_sid");
    expect(sql).toContain("outbox.dedupe_key like 'inbound\\_reply\\_%'");
    expect(sql).toContain("having count(distinct number.workspace_id) > 1");
    expect(sql).toContain("raise exception 'manager_sms migration blocked");
    expect(sql).toContain("message.source_message_sid = inbound.message_sid");
    expect(sql).not.toContain("delete from public.manager_sms_messages where counterparty_role = 'manager'");
    expect(sql).not.toContain("delete from public.inbound_sms_log where counterparty_role = 'manager'");
  });

  it("adds persisted SMS turns before the next browser turn", () => {
    expect(mergePersistedChatHistory([
      { role: "user", content: "Portal question" },
      { role: "assistant", content: "Portal answer" },
      { role: "user", content: "SMS follow-up" },
      { role: "assistant", content: "SMS answer" },
    ], { role: "user", content: "Continue in the browser" })).toEqual([
      { role: "user", content: "Portal question" },
      { role: "assistant", content: "Portal answer" },
      { role: "user", content: "SMS follow-up" },
      { role: "assistant", content: "SMS answer" },
      { role: "user", content: "Continue in the browser" },
    ]);
  });

  it("keeps managed send authorization while suppressing only the duplicate projection", () => {
    const transport = readFileSync(join(process.cwd(), "src/lib/proplane-sms-transport.server.ts"), "utf8");
    expect(transport).toContain("suppressConversationLog: args.skipLog === true");
    expect(transport).toMatch(/log:\s*\{\s*managerUserId,/);
  });
});
