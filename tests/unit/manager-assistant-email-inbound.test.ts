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
  mirrorAssistantEmailConversation: vi.fn(),
  resolveResidentInboxAgentContext: vi.fn(),
  autoRespondToResidentInboxMessage: vi.fn(),
  runLeasingEmailAgentTurn: vi.fn(),
}));

vi.mock("@/lib/manager-assistant-email/mirror-assistant-email-conversation.server", () => ({
  mirrorAssistantEmailConversation: mocks.mirrorAssistantEmailConversation,
}));

vi.mock("@/lib/tools/resident-inbox-context", () => ({
  resolveResidentInboxAgentContext: mocks.resolveResidentInboxAgentContext,
}));

vi.mock("@/lib/agent/inbox-auto-respond.server", () => ({
  autoRespondToResidentInboxMessage: mocks.autoRespondToResidentInboxMessage,
}));

vi.mock("@/lib/agent/leasing-email-agent.server", () => ({
  runLeasingEmailAgentTurn: mocks.runLeasingEmailAgentTurn,
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
    mocks.mirrorAssistantEmailConversation.mockResolvedValue(undefined);
    // Default: the sender is not a resident of this manager.
    mocks.resolveResidentInboxAgentContext.mockResolvedValue({ ok: false, reason: "not_a_resident" });
    mocks.autoRespondToResidentInboxMessage.mockResolvedValue({
      ok: true,
      reply: "Your rent is due on the 1st.",
      model: "m",
      traceId: null,
    });
    mocks.runLeasingEmailAgentTurn.mockResolvedValue({
      reply: "Yes, Room 2 is still available.",
      sessionId: "leasing-sess",
      traceId: null,
    });
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
    expect(result).toMatchObject({ handled: true, replied: true, role: "manager" });
    expect(mocks.runManagerEmailAgentTurn).toHaveBeenCalled();
    expect(mocks.mirrorAssistantEmailTurnToInbox).toHaveBeenCalled();
    expect(mocks.deliverManagerEmailReply).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "mgr@example.com" }),
    );
  });

  /**
   * The three-role dispatch. Before it, a sender who was not the manager or an
   * accepted co-manager fell out of the identity gate as `null` and the mail was
   * dropped: no reply, nothing in Communication, and no redelivery — the inbound
   * id is claimed before the sender is resolved.
   */
  describe("sender routing", () => {
    const fromProspect = { ...parsed, fromEmail: "renter@example.com", fromName: "Renter" };

    it("answers a current resident with the resident assistant", async () => {
      mocks.resolveManagerEmailInboundIdentity.mockResolvedValue(null);
      mocks.resolveResidentInboxAgentContext.mockResolvedValue({
        ok: true,
        ctx: { kind: "resident", userId: "res-1", email: "renter@example.com" },
      });

      const result = await processManagerAssistantInboundEmail(db, fromProspect);

      expect(result).toMatchObject({ handled: true, replied: true, role: "resident" });
      expect(mocks.autoRespondToResidentInboxMessage).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ managerUserId: "mgr-1", residentEmail: "renter@example.com" }),
      );
      expect(mocks.runLeasingEmailAgentTurn).not.toHaveBeenCalled();
      // Never the manager's own assistant thread — this is a conversation with a person.
      expect(mocks.mirrorAssistantEmailTurnToInbox).not.toHaveBeenCalled();
      expect(mocks.mirrorAssistantEmailConversation).toHaveBeenCalled();
    });

    it("answers everyone else with the leasing assistant", async () => {
      mocks.resolveManagerEmailInboundIdentity.mockResolvedValue(null);

      const result = await processManagerAssistantInboundEmail(db, fromProspect);

      expect(result).toMatchObject({ handled: true, replied: true, role: "prospect" });
      expect(mocks.runLeasingEmailAgentTurn).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ landlordId: "mgr-1", prospectEmail: "renter@example.com" }),
      );
      expect(mocks.autoRespondToResidentInboxMessage).not.toHaveBeenCalled();
    });

    it("replies to the sender, never to the mailbox owner", async () => {
      mocks.resolveManagerEmailInboundIdentity.mockResolvedValue(null);
      await processManagerAssistantInboundEmail(db, fromProspect);
      expect(mocks.deliverManagerEmailReply).toHaveBeenCalledWith(
        expect.objectContaining({ toEmail: "renter@example.com" }),
      );
    });

    it("still shows the mail in Communication when no reply was produced", async () => {
      mocks.resolveManagerEmailInboundIdentity.mockResolvedValue(null);
      mocks.runLeasingEmailAgentTurn.mockResolvedValue(null);

      const result = await processManagerAssistantInboundEmail(db, fromProspect);

      expect(result).toMatchObject({ handled: true, replied: false, role: "prospect" });
      expect(mocks.deliverManagerEmailReply).not.toHaveBeenCalled();
      expect(mocks.mirrorAssistantEmailConversation).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ senderEmail: "renter@example.com", replyText: null }),
      );
    });

    it("keeps a manager who is also a resident on the manager assistant", async () => {
      // Manager gate wins: a manager must not be demoted to a resident view of
      // their own mailbox just because they also rent somewhere.
      mocks.resolveResidentInboxAgentContext.mockResolvedValue({
        ok: true,
        ctx: { kind: "resident", userId: "mgr-1", email: "mgr@example.com" },
      });

      const result = await processManagerAssistantInboundEmail(db, parsed);

      expect(result).toMatchObject({ role: "manager" });
      expect(mocks.autoRespondToResidentInboxMessage).not.toHaveBeenCalled();
    });
  });
});
