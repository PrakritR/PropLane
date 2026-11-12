import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendAsPropLaneAfterRefusal: vi.fn(),
  recordDeliveryIssue: vi.fn(),
  clearDeliveryIssue: vi.fn(),
  locateThreadId: vi.fn(),
  resolveWorkspaceContext: vi.fn(),
}));

vi.mock("@/lib/prospect-spine/payer.server", () => ({ sendAsPropLaneAfterRefusal: mocks.sendAsPropLaneAfterRefusal }));
vi.mock("@/lib/prospect-spine/delivery-issue.server", () => ({ recordDeliveryIssue: mocks.recordDeliveryIssue, clearDeliveryIssue: mocks.clearDeliveryIssue }));
vi.mock("@/lib/prospect-spine/locate.server", () => ({ locateThreadId: mocks.locateThreadId }));
vi.mock("@/lib/communication/conversation-key.server", () => ({ resolveWorkspaceContext: mocks.resolveWorkspaceContext }));
// The core's other imports are not exercised by the settle step.
vi.mock("@/lib/manager-sms-messages.server", () => ({ fetchManagerSmsConversations: vi.fn(), resolveSmsScopeManagerIds: vi.fn() }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: vi.fn(), dispatchOwnerSmsOutbox: vi.fn() }));
vi.mock("@/lib/one-number/shared-line-number.server", () => ({ resolveSharedLineHumanSend: vi.fn() }));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveConversationSendLine: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/one-number/knowledge/send-hook.server", () => ({ learnFromManagerSend: vi.fn() }));
vi.mock("@/lib/manager-communication-access.server", () => ({ assertManagerCommunicationAllowed: vi.fn() }));
vi.mock("@/lib/vendor-work-identity.server", () => ({ getRoutableVendorNumber: vi.fn() }));
vi.mock("@/lib/sms/vendor-conversation-consent.server", () => ({
  VENDOR_CONVERSATION_PURPOSE: "vendor_conversation", VENDOR_TEXT_ATTESTATION_SOURCE: "x", buildVendorSenderLine: vi.fn(),
  carryVendorConsentToKey: vi.fn(), readVendorTextConsent: vi.fn(), recordManagerAttestedVendorConsent: vi.fn(), recordVendorInboundReplyConsent: vi.fn(),
}));

import { settleRefusedConversationSend } from "@/lib/manager-sms-send.server";

const input = { ownerManagerUserId: "owner-1", workspaceId: "ws-1", propertyId: null, toPhone: "+12065550151", text: "Hi there", claimKey: "sms_manager_abc" };
const refused = { status: 503, body: { error: "Could not queue SMS.", code: "comms_billing_allowance_exhausted" } };
const db = {} as never;

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.locateThreadId.mockResolvedValue("sms_notice_1");
  mocks.resolveWorkspaceContext.mockResolvedValue({ workspaceId: "ws-1" });
});

describe("a refused inbox text is never silent", () => {
  it("a sent or queued text passes through untouched", async () => {
    const ok = { status: 200, body: { ok: true } };
    expect(await settleRefusedConversationSend(db, ok, input)).toBe(ok);
    expect(mocks.recordDeliveryIssue).not.toHaveBeenCalled();
    expect(mocks.sendAsPropLaneAfterRefusal).not.toHaveBeenCalled();
  });

  it("managed workspace: the wallet refusal falls back to PropLane with the structured code, the send reads submitted and the issue clears", async () => {
    mocks.sendAsPropLaneAfterRefusal.mockResolvedValue({ attempted: true, ok: true });
    const out = await settleRefusedConversationSend(db, refused, input);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, status: "submitted", viaPropLane: true });
    expect(mocks.sendAsPropLaneAfterRefusal).toHaveBeenCalledWith(db, expect.objectContaining({
      ownerUserId: "owner-1", workspaceId: "ws-1", to: "+12065550151", body: "Hi there", refusalCode: "comms_billing_allowance_exhausted",
    }));
    expect(mocks.clearDeliveryIssue).toHaveBeenCalledWith(db, "sms_notice_1");
    expect(mocks.recordDeliveryIssue).not.toHaveBeenCalled();
  });

  it("self-serve workspace (fallback not attempted): the refusal stays, with a delivery issue and its human reason on the thread", async () => {
    mocks.sendAsPropLaneAfterRefusal.mockResolvedValue({ attempted: false, ok: false, reason: "not_managed" });
    const out = await settleRefusedConversationSend(db, refused, input);
    expect(out).toBe(refused);
    expect(mocks.recordDeliveryIssue).toHaveBeenCalledWith(db, expect.objectContaining({
      threadId: "sms_notice_1", direction: "outbound", reason: "Could not queue SMS.",
    }));
  });

  it("fallback attempted but failed: the issue names both failures", async () => {
    mocks.sendAsPropLaneAfterRefusal.mockResolvedValue({ attempted: true, ok: false, reason: "quiet_hours" });
    await settleRefusedConversationSend(db, refused, input);
    expect(mocks.recordDeliveryIssue).toHaveBeenCalledWith(db, expect.objectContaining({ reason: expect.stringContaining("quiet hours") }));
  });

  it("a non-wallet refusal (STOP, consent) never falls back, but is still recorded", async () => {
    mocks.sendAsPropLaneAfterRefusal.mockResolvedValue({ attempted: false, ok: false, reason: "refusal_not_eligible" });
    const stopped = { status: 503, body: { error: "That number has opted out of texts.", code: "recipient_opted_out" } };
    await settleRefusedConversationSend(db, stopped, input);
    expect(mocks.sendAsPropLaneAfterRefusal).toHaveBeenCalledWith(db, expect.objectContaining({ refusalCode: "recipient_opted_out" }));
    expect(mocks.recordDeliveryIssue).toHaveBeenCalledWith(db, expect.objectContaining({ reason: "That number has opted out of texts." }));
  });

  it("a refusal before the enqueue (no claim key) is recorded without any fallback", async () => {
    await settleRefusedConversationSend(db, { status: 402, body: { error: "Upgrade to message.", code: "communication_trial" } }, { ...input, claimKey: null });
    expect(mocks.sendAsPropLaneAfterRefusal).not.toHaveBeenCalled();
    expect(mocks.recordDeliveryIssue).toHaveBeenCalledWith(db, expect.objectContaining({ reason: "Upgrade to message." }));
  });

  it("the workspace is derived when the caller has none, and a helper that throws never hides the refusal", async () => {
    mocks.resolveWorkspaceContext.mockResolvedValue({ workspaceId: "ws-derived" });
    mocks.sendAsPropLaneAfterRefusal.mockRejectedValue(new Error("boom"));
    const out = await settleRefusedConversationSend(db, refused, { ...input, workspaceId: null });
    expect(out).toBe(refused);
    expect(mocks.locateThreadId).toHaveBeenCalledWith(db, expect.objectContaining({ workspaceId: "ws-derived" }));
  });
});
