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
  resolveWorkspaceOwnerForWorkEmail: vi.fn(),
  findOrCreateResidentEmailSession: vi.fn(),
  loadResidentEmailHistory: vi.fn(),
  recordResidentEmailInbound: vi.fn(),
  recordResidentEmailReply: vi.fn(),
}));

vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  resolveWorkspaceOwnerForWorkEmail: mocks.resolveWorkspaceOwnerForWorkEmail,
}));

vi.mock("@/lib/agent/resident-email-session.server", () => ({
  findOrCreateResidentEmailSession: mocks.findOrCreateResidentEmailSession,
  loadResidentEmailHistory: mocks.loadResidentEmailHistory,
  recordResidentEmailInbound: mocks.recordResidentEmailInbound,
  recordResidentEmailReply: mocks.recordResidentEmailReply,
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
  // The code resolves the MAILBOX (owner + workspace); the spec still thinks in owner ids, so
  // the mailbox is that owner on a legacy, unplaced row unless a case says otherwise.
  resolveAssistantMailboxByInboundAddresses: async (db: unknown, addresses: string[]) => {
    const managerUserId = await mocks.resolveManagerIdByAssistantInboundAddresses(db, addresses);
    return managerUserId ? { managerUserId, workspaceId: null } : null;
  },
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
    // Default: the mailbox is the owner's own; nothing collapses.
    mocks.resolveWorkspaceOwnerForWorkEmail.mockImplementation(async (_db: unknown, id: string) => ({
      ownerUserId: id,
      sharedFromCoManager: false,
      workspaceId: null,
    }));
    mocks.findOrCreateResidentEmailSession.mockResolvedValue({ id: "res-sess", landlord_id: "mgr-1" });
    mocks.loadResidentEmailHistory.mockResolvedValue([]);
    mocks.recordResidentEmailInbound.mockResolvedValue(undefined);
    mocks.recordResidentEmailReply.mockResolvedValue(undefined);

    const insert = vi.fn().mockResolvedValue({ error: null });
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert });
  });

  it("returns handled:false for non-assistant addresses", async () => {
    const result = await processManagerAssistantInboundEmail(db, {
      ...parsed,
      toEmails: ["support@proplane.ai"],
    });
    expect(result).toEqual({ handled: false });
  });

  /**
   * Reserved local parts (`support`, `admin`, …) are never a mailbox local, no
   * matter how the manager scheme evolves — `admin` is not the legacy `assist-`
   * shape either, so this pins the general rule, not just the `support@` case.
   */
  it("returns handled:false for admin@ — a reserved local, never a mailbox", async () => {
    const result = await processManagerAssistantInboundEmail(db, {
      ...parsed,
      toEmails: ["admin@prop-lane.space"],
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
   * The custom local part (Settings → "set_address") is a normal `<local>@`
   * address like `assist-<slug>@`, not a legacy plus token — this file mocks
   * `resolveAssistantMailboxByInboundAddresses` itself, so it pins that the
   * front door (`isAssistantEmailAddress`, real/unmocked) still recognises a
   * `frontdesk@…` To address as in-domain and lets it reach that resolver, the
   * same as it does for the legacy `assistant+<token>@…` form.
   */
  it("still passes a custom-local-part address (e.g. frontdesk@) to the mailbox resolver", async () => {
    const result = await processManagerAssistantInboundEmail(db, {
      ...parsed,
      toEmails: ["frontdesk@prop-lane.space"],
    });
    expect(result).toMatchObject({ handled: true, replied: true, role: "manager" });
    expect(mocks.resolveManagerIdByAssistantInboundAddresses).toHaveBeenCalledWith(
      db,
      ["frontdesk@prop-lane.space"],
    );
  });

  it("still passes the legacy assistant+<token>@ form to the mailbox resolver", async () => {
    const result = await processManagerAssistantInboundEmail(db, parsed);
    expect(result).toMatchObject({ handled: true, replied: true });
    expect(mocks.resolveManagerIdByAssistantInboundAddresses).toHaveBeenCalledWith(
      db,
      parsed.toEmails,
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

    it("tells the mirror whether the reply actually left, so the tag is honest", async () => {
      mocks.resolveManagerEmailInboundIdentity.mockResolvedValue(null);
      await processManagerAssistantInboundEmail(db, fromProspect);
      expect(mocks.mirrorAssistantEmailConversation).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ replySent: true }),
      );
      // The mirror runs AFTER the send: it needs the outcome to stamp the reply.
      const sendOrder = mocks.deliverManagerEmailReply.mock.invocationCallOrder[0];
      const mirrorOrder = mocks.mirrorAssistantEmailConversation.mock.invocationCallOrder[0];
      expect(sendOrder).toBeLessThan(mirrorOrder);

      mocks.deliverManagerEmailReply.mockResolvedValue({ ok: false });
      mocks.mirrorAssistantEmailConversation.mockClear();
      await processManagerAssistantInboundEmail(db, { ...fromProspect, emailId: "email-failed-send" });
      expect(mocks.mirrorAssistantEmailConversation).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ replySent: false }),
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

  /**
   * One work email per WORKSPACE. An address still held by a pure co-manager
   * (requested before the rule) answers as the owner's workspace — collapsed
   * BEFORE the sender is classified, exactly as the SMS webhook collapses a
   * legacy co-manager line.
   */
  describe("workspace ownership", () => {
    it("collapses a legacy co-manager address to the workspace owner before routing", async () => {
      mocks.resolveManagerIdByAssistantInboundAddresses.mockResolvedValue("co-1");
      mocks.resolveWorkspaceOwnerForWorkEmail.mockResolvedValue({
        ownerUserId: "owner-1",
        sharedFromCoManager: true,
        workspaceId: null,
      });
      mocks.resolveManagerEmailInboundIdentity.mockResolvedValue(null);
      mocks.loadManagerAssistantEmail.mockImplementation(async (_db: unknown, id: string) =>
        id === "owner-1"
          ? { managerUserId: "owner-1", inboxToken: "tok0000000001", address: "assist-owner@prop-lane.space", provisionState: "active" }
          : { managerUserId: "co-1", inboxToken: "tok12345678", address: "assist-bob-lee@prop-lane.space", provisionState: "active" },
      );

      const result = await processManagerAssistantInboundEmail(db, {
        ...parsed,
        fromEmail: "renter@example.com",
        toEmails: ["assist-bob-lee@prop-lane.space"],
      });

      expect(result).toMatchObject({ handled: true, replied: true, role: "prospect" });
      // The prospect reaches the OWNER's listings...
      expect(mocks.runLeasingEmailAgentTurn).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ landlordId: "owner-1" }),
      );
      // ...the thread lands in the OWNER's Communication...
      expect(mocks.mirrorAssistantEmailConversation).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ managerUserId: "owner-1" }),
      );
      // ...and the reply comes from the workspace's address.
      expect(mocks.deliverManagerEmailReply).toHaveBeenCalledWith(
        expect.objectContaining({ fromAddress: "assist-owner@prop-lane.space" }),
      );
    });

    it("falls back to the address written to when the owner has none of their own", async () => {
      mocks.resolveManagerIdByAssistantInboundAddresses.mockResolvedValue("co-1");
      mocks.resolveWorkspaceOwnerForWorkEmail.mockResolvedValue({
        ownerUserId: "owner-1",
        sharedFromCoManager: true,
        workspaceId: null,
      });
      mocks.resolveManagerEmailInboundIdentity.mockResolvedValue(null);
      mocks.loadManagerAssistantEmail.mockImplementation(async (_db: unknown, id: string) =>
        id === "co-1"
          ? { managerUserId: "co-1", inboxToken: "tok12345678", address: "assist-bob-lee@prop-lane.space", provisionState: "active" }
          : null,
      );

      await processManagerAssistantInboundEmail(db, {
        ...parsed,
        fromEmail: "renter@example.com",
        toEmails: ["assist-bob-lee@prop-lane.space"],
      });

      expect(mocks.deliverManagerEmailReply).toHaveBeenCalledWith(
        expect.objectContaining({ fromAddress: "assist-bob-lee@prop-lane.space" }),
      );
    });

    it("mirrors a co-manager's own questions into THEIR assistant thread, not the owner's", async () => {
      mocks.resolveManagerEmailInboundIdentity.mockResolvedValue({
        workNumberOwnerId: "mgr-1",
        actorUserId: "co-1",
        actorEmail: "co@example.com",
        access: { mode: "delegated", workNumberOwnerId: "mgr-1", actorUserId: "co-1", dataOwnerIds: ["mgr-1"], assignedPropertyIds: ["p1"] },
      });

      const result = await processManagerAssistantInboundEmail(db, { ...parsed, fromEmail: "co@example.com" });

      expect(result).toMatchObject({ role: "manager", replied: true });
      expect(mocks.mirrorAssistantEmailTurnToInbox).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ managerUserId: "co-1" }),
      );
    });
  });

  /**
   * A resident who writes twice is answered by a model that saw the first
   * email. The prospect branch already had this; the resident branch called the
   * auto-responder with no history at all.
   */
  describe("resident memory", () => {
    const fromResident = { ...parsed, fromEmail: "renter@example.com", fromName: "Renter" };

    beforeEach(() => {
      mocks.resolveManagerEmailInboundIdentity.mockResolvedValue(null);
      mocks.resolveResidentInboxAgentContext.mockResolvedValue({
        ok: true,
        ctx: { kind: "resident", userId: "res-1", email: "renter@example.com" },
      });
    });

    it("hands the resident assistant the thread so far and persists both turns", async () => {
      mocks.loadResidentEmailHistory.mockResolvedValue([
        { from: "resident", body: "Is September paid?" },
        { from: "manager", body: "Yes, on the 3rd." },
      ]);

      await processManagerAssistantInboundEmail(db, { ...fromResident, text: "And October?" });

      expect(mocks.findOrCreateResidentEmailSession).toHaveBeenCalledWith(
        db,
        { landlordId: "mgr-1", residentEmail: "renter@example.com" },
      );
      expect(mocks.recordResidentEmailInbound).toHaveBeenCalledWith(
        db,
        { id: "res-sess", landlord_id: "mgr-1" },
        { text: "And October?", inboundEmailId: "email_123" },
      );
      expect(mocks.autoRespondToResidentInboxMessage).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          history: [
            { from: "resident", body: "Is September paid?" },
            { from: "manager", body: "Yes, on the 3rd." },
          ],
          sessionId: "res-sess",
        }),
      );
      expect(mocks.recordResidentEmailReply).toHaveBeenCalledWith(
        db,
        { id: "res-sess", landlord_id: "mgr-1" },
        { text: "Your rent is due on the 1st.", traceId: null },
      );
    });

    it("still answers, without memory, when a session cannot be created", async () => {
      mocks.findOrCreateResidentEmailSession.mockResolvedValue(null);

      const result = await processManagerAssistantInboundEmail(db, fromResident);

      expect(result).toMatchObject({ role: "resident", replied: true });
      expect(mocks.autoRespondToResidentInboxMessage).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ history: [], sessionId: undefined }),
      );
      expect(mocks.recordResidentEmailReply).not.toHaveBeenCalled();
    });
  });
});
