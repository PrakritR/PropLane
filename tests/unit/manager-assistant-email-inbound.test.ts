import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveManagerIdByAssistantInboundAddresses: vi.fn(),
  resolveManagerEmailInboundIdentity: vi.fn(),
  resolveManagerSmsAgentContext: vi.fn(),
  runManagerEmailAgentTurn: vi.fn(),
  loadManagerAssistantEmail: vi.fn(),
  deliverManagerEmailReply: vi.fn(),
  resolveInboundEmailBody: vi.fn(),
  mirrorAssistantEmailTurnToInbox: vi.fn(),
}));

vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  resolveManagerIdByAssistantInboundAddresses: mocks.resolveManagerIdByAssistantInboundAddresses,
  loadManagerAssistantEmail: mocks.loadManagerAssistantEmail,
}));

vi.mock("@/lib/manager-assistant-email/mirror-assistant-email-to-inbox.server", () => ({
  mirrorAssistantEmailTurnToInbox: mocks.mirrorAssistantEmailTurnToInbox,
}));

vi.mock("@/lib/manager-assistant-email/manager-email-access.server", () => ({
  resolveManagerEmailInboundIdentity: mocks.resolveManagerEmailInboundIdentity,
}));

vi.mock("@/lib/tools/manager-sms-context", () => ({
  resolveManagerSmsAgentContext: mocks.resolveManagerSmsAgentContext,
}));

vi.mock("@/lib/agent/manager-email-agent.server", () => ({
  runManagerEmailAgentTurn: mocks.runManagerEmailAgentTurn,
  deliverManagerEmailReply: mocks.deliverManagerEmailReply,
}));

vi.mock("@/lib/inbound-email/inbound-email.server", () => ({
  resolveInboundEmailBody: mocks.resolveInboundEmailBody,
}));

import { processManagerAssistantInboundEmail } from "@/lib/manager-assistant-email/process-assistant-inbound.server";

describe("processManagerAssistantInboundEmail", () => {
  const db = {
    from: vi.fn(),
  } as unknown as import("@supabase/supabase-js").SupabaseClient;

  const parsed = {
    emailId: "email_123",
    fromEmail: "mgr@example.com",
    fromName: "Mgr",
    toEmails: ["assistant+tok12345678@prop-lane.space"],
    subject: "Rent roll",
    receivedAt: new Date().toISOString(),
    text: "How many vacant units?",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ASSISTANT_EMAIL_DOMAIN = "prop-lane.space";
    mocks.resolveManagerIdByAssistantInboundAddresses.mockResolvedValue("mgr-1");
    mocks.resolveManagerEmailInboundIdentity.mockResolvedValue({
      workNumberOwnerId: "mgr-1",
      actorUserId: "mgr-1",
      actorEmail: "mgr@example.com",
      access: { mode: "owner", workNumberOwnerId: "mgr-1", actorUserId: "mgr-1", dataOwnerIds: ["mgr-1"], assignedPropertyIds: [] },
    });
    mocks.resolveManagerSmsAgentContext.mockResolvedValue({
      ok: true,
      ctx: { landlordId: "mgr-1", userId: "mgr-1", email: "mgr@example.com", roles: ["manager"], isAdmin: false, db },
    });
    mocks.runManagerEmailAgentTurn.mockResolvedValue({ reply: "You have 2 vacant units.", sessionId: "sess-1" });
    mocks.loadManagerAssistantEmail.mockResolvedValue({
      managerUserId: "mgr-1",
      inboxToken: "tok12345678",
      address: "assistant+tok12345678@prop-lane.space",
      provisionState: "active",
    });
    mocks.mirrorAssistantEmailTurnToInbox.mockResolvedValue(undefined);
    mocks.deliverManagerEmailReply.mockResolvedValue({ ok: true });

    const insert = vi.fn().mockResolvedValue({ error: null });
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert });
  });

  it("returns handled:false for non-assistant addresses", async () => {
    const result = await processManagerAssistantInboundEmail(db, {
      ...parsed,
      toEmails: ["support@prop-lane.space"],
    });
    expect(result).toEqual({ handled: false });
  });

  it("runs the agent and sends a reply for a verified manager", async () => {
    const result = await processManagerAssistantInboundEmail(db, parsed);
    expect(result).toEqual({ handled: true, replied: true });
    expect(mocks.runManagerEmailAgentTurn).toHaveBeenCalled();
    expect(mocks.mirrorAssistantEmailTurnToInbox).toHaveBeenCalled();
    expect(mocks.deliverManagerEmailReply).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "mgr@example.com" }),
    );
  });
});
