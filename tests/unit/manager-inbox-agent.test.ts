import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeWritableCtx } from "./tools/fake-agent-ctx";

const { runAgentTurn, createPendingActionForUser, commitInboxThreadReply, track } = vi.hoisted(() => ({
  runAgentTurn: vi.fn(), createPendingActionForUser: vi.fn(),
  commitInboxThreadReply: vi.fn(), track: vi.fn(),
}));
vi.mock("@/lib/agent/loop", () => ({ runAgentTurn }));
vi.mock("@/lib/tools", () => ({ agentRegistry: {} }));
vi.mock("@/lib/tools/pending-actions", () => ({ createPendingActionForUser }));
vi.mock("@/lib/portal-inbox-delivery", () => ({ commitInboxThreadReply }));
vi.mock("@/lib/analytics/posthog", () => ({ track }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/observability/langfuse", () => ({
  traceAgentTurn: async (_actor: unknown, _messages: unknown, run: (observer: unknown) => unknown,
    opts: { onTraceId: (id: string) => void }) => {
    opts.onTraceId("trace-1");
    return run({});
  },
}));

import { runManagerInboxAgentTurn } from "@/lib/agent/manager-inbox-agent.server";

const target = { threadId: "thread-1", ownerUserId: "manager-1", scope: "axis_portal_inbox_manager_v1",
  participantEmail: null, threadType: "agent_notice", rowData: {} };
const proposal = { toolName: "send_message", input: { text: "A draft" },
  preview: { title: "Send a message", fields: [], confirmLabel: "Send" } };
function db() {
  return makeWritableCtx({
    profiles: [{ id: "manager-1", role: "manager", email: "manager@example.com" }],
    profile_roles: [{ user_id: "manager-1", role: "manager" }],
    portal_inbox_thread_records: [{ id: "thread-1", row_data: { messages: [
      { from: "Property manager", body: "Send a message" },
    ] } }],
  }).ctx.db as unknown as SupabaseClient;
}
beforeEach(() => {
  vi.clearAllMocks();
  runAgentTurn.mockResolvedValue({ reply: "Review this draft", pendingAction: proposal });
  createPendingActionForUser.mockResolvedValue("action-1");
  commitInboxThreadReply.mockResolvedValue(undefined);
});

describe("manager inbox assistant", () => {
  it("passes the committed incoming message once and persists the approval with its trace", async () => {
    const database = db();
    expect(await runManagerInboxAgentTurn(database, target, "manager-1", "Send a message")).toEqual({ replied: true });
    expect(runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: "user", content: "Send a message" }], allowWriteTools: [],
    }));
    expect(createPendingActionForUser).toHaveBeenCalledWith(database, {
      landlordId: "manager-1", userId: "manager-1", portal: "manager",
      ...proposal, proposalTraceId: "trace-1",
    });
    expect(commitInboxThreadReply).toHaveBeenCalledWith(database, target, expect.objectContaining({
      text: expect.stringContaining("Open your dashboard to approve"), outbound: false,
    }));
  });

  it("does not promise an approval when the proposal could not be saved", async () => {
    createPendingActionForUser.mockResolvedValue(null);
    await runManagerInboxAgentTurn(db(), target, "manager-1", "Send a message");
    const body = commitInboxThreadReply.mock.calls[0]![2].text;
    expect(body).toContain("could not prepare");
    expect(body).not.toContain("Open your dashboard to approve");
    expect(track).not.toHaveBeenCalledWith("assistant_action_proposed", expect.anything(), expect.anything());
  });

  it("reports a reply persistence failure instead of acknowledging a reply", async () => {
    commitInboxThreadReply.mockRejectedValue(new Error("database unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runManagerInboxAgentTurn(db(), target, "manager-1", "Send a message"))
        .toEqual({ replied: false, reason: "agent_turn_failed" });
      expect(track).not.toHaveBeenCalledWith("assistant_message_sent", expect.anything(), expect.anything());
      expect(track).toHaveBeenCalledWith("assistant_reply_failed", "manager-1", {
        portal: "manager", surface: "inbox", reason: "agent_turn_failed",
      });
    } finally { errorLog.mockRestore(); }
  });
});
