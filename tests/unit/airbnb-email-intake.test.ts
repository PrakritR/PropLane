import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  resolveMailbox: vi.fn(),
  resolveOwner: vi.fn(),
  loadMailbox: vi.fn(),
  mirror: vi.fn(),
  fetchHeaders: vi.fn(),
  resolveBody: vi.fn(),
  deliver: vi.fn(),
  classify: vi.fn(),
  leasing: vi.fn(),
  reserve: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveWorkspaceOwnerForWorkEmail: mocks.resolveOwner }));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  resolveAssistantMailboxByInboundAddresses: mocks.resolveMailbox,
  loadManagerAssistantEmail: mocks.loadMailbox,
}));
vi.mock("@/lib/manager-assistant-email/mirror-assistant-email-conversation.server", () => ({ mirrorAssistantEmailConversation: mocks.mirror }));
vi.mock("@/lib/manager-assistant-email/mirror-assistant-email-to-inbox.server", () => ({ mirrorAssistantEmailTurnToInbox: vi.fn() }));
vi.mock("@/lib/inbound-email/inbound-email-headers.server", () => ({ fetchResendReceivedEmailHeaders: mocks.fetchHeaders }));
vi.mock("@/lib/inbound-email/inbound-email.server", () => ({ resolveInboundEmailBody: mocks.resolveBody }));
vi.mock("@/lib/agent/manager-email-agent.server", () => ({ runManagerEmailAgentTurn: vi.fn(), deliverManagerEmailReply: mocks.deliver }));
vi.mock("@/lib/manager-assistant-email/assistant-email-sender-role.server", () => ({ classifyAssistantEmailSender: mocks.classify }));
vi.mock("@/lib/agent/leasing-email-agent.server", () => ({ runLeasingEmailAgentTurn: mocks.leasing }));
vi.mock("@/lib/agent/inbox-auto-respond.server", () => ({ autoRespondToResidentInboxMessage: vi.fn() }));
vi.mock("@/lib/agent/resident-email-session.server", () => ({
  findOrCreateResidentEmailSession: vi.fn(), loadResidentEmailHistory: vi.fn(), recordResidentEmailInbound: vi.fn(), recordResidentEmailReply: vi.fn(),
}));
vi.mock("@/lib/manager-assistant-email/email-auto-reply-credit.server", () => ({ reserveEmailAutoReplyCredit: mocks.reserve, finishEmailAutoReplyCredit: vi.fn() }));
vi.mock("@/lib/automation-send-mode.server", () => ({ partyFacingAnswerHold: vi.fn() }));
vi.mock("@/lib/tools/manager-sms-context", () => ({ resolveManagerSmsAgentContext: vi.fn() }));
vi.mock("@/lib/channel-calendar/airbnb-email-intake.server", () => ({ applyAirbnbEmailToStay: mocks.apply }));

import { processManagerAssistantInboundEmail } from "@/lib/manager-assistant-email/process-assistant-inbound.server";
import type { SupabaseClient } from "@supabase/supabase-js";

// SYNTHETIC Airbnb-style body (shape only).
const PAYOUT_BODY = "We've sent your payout of $412.00\nPayout for Juan's stay\nReservation HMHW5SHXRB\nCheck-in Oct 13, 2026\nCheckout Oct 16, 2026\nTotal payout $412.00\n";

const parsed = {
  emailId: "em_1",
  fromEmail: "automated@airbnb.com",
  fromName: "Airbnb",
  toEmails: ["assistant+tok12345678@prop-lane.space"],
  subject: "Your payout is on the way",
  receivedAt: "2026-10-17T09:00:00.000Z",
  text: PAYOUT_BODY,
};

function db(): SupabaseClient {
  return { from: () => ({ insert: async () => ({ error: null }) }) } as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ASSISTANT_EMAIL_DOMAIN = "prop-lane.space";
  mocks.resolveMailbox.mockResolvedValue({ managerUserId: "mgr-1", workspaceId: null });
  mocks.resolveOwner.mockResolvedValue({ ownerUserId: "mgr-1", sharedFromCoManager: false, workspaceId: null });
  mocks.loadMailbox.mockResolvedValue({ address: "assistant+tok12345678@prop-lane.space" });
  mocks.mirror.mockResolvedValue(undefined);
  mocks.fetchHeaders.mockResolvedValue({ "authentication-results": ["mx; dkim=pass header.d=airbnb.com"] });
  mocks.apply.mockResolvedValue({ applied: true, connectionId: "c1", sourceUid: "u1" });
});

describe("Airbnb mail to the work email", () => {
  it("applies a matched payout to the stay with no reply, no thread and no agent turn", async () => {
    const result = await processManagerAssistantInboundEmail(db(), parsed);
    expect(result).toEqual({ handled: true, replied: false });
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), "mgr-1", expect.objectContaining({ kind: "payout", confirmationCode: "HMHW5SHXRB", payoutCents: 41200 }), parsed.receivedAt);
    expect(mocks.mirror).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.leasing).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("stores an unmatched Airbnb mail like other inbound mail and never answers it", async () => {
    mocks.apply.mockResolvedValue({ applied: false, reason: "no_match" });
    const result = await processManagerAssistantInboundEmail(db(), parsed);
    expect(result).toEqual({ handled: true, replied: false });
    expect(mocks.mirror).toHaveBeenCalledTimes(1);
    expect(mocks.mirror.mock.calls[0]![1]).toMatchObject({ replyText: null, replySent: false, residentUserId: null });
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.leasing).not.toHaveBeenCalled();
  });

  it("does not believe an airbnb.com From the receiving server did not authenticate", async () => {
    mocks.fetchHeaders.mockResolvedValue({ "authentication-results": ["mx; dkim=fail header.d=airbnb.com"] });
    const result = await processManagerAssistantInboundEmail(db(), parsed);
    expect(result).toEqual({ handled: true, replied: false });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.mirror).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});

