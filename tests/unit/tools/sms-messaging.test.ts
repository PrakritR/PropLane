import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
import { previewWrite, executeWrite } from "./fake-agent-ctx";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), scope: vi.fn(), smsScope: vi.fn(), enqueue: vi.fn(), dispatch: vi.fn(),
  audit: vi.fn(), auditResult: vi.fn(), track: vi.fn(), status: "submitted",
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  fetchManagerSmsConversations: mocks.fetch,
  resolveSmsScopeManagerIds: mocks.scope,
}));
vi.mock("@/lib/sms/manager-sms-access.server", () => ({ smsInboxOwnerIds: mocks.smsScope }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: mocks.enqueue, dispatchOwnerSmsOutbox: mocks.dispatch,
}));
vi.mock("@/lib/tools/audit", () => ({
  writeAuditLog: mocks.audit, updateAuditResult: mocks.auditResult, auditDayBucket: () => "2026-09-08",
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: mocks.track }));
import { listSmsConversationsTool, replyToSmsConversationTool } from "@/lib/tools/domains/sms-messaging";
import { sendManagerConversationSms } from "@/lib/manager-sms-send.server";

const db = {
  from: (table: string) => {
    if (table !== "sms_outbox") throw new Error(`Unexpected table ${table}`);
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: { status: mocks.status }, error: null }) };
    return query;
  },
};
const ctx = { db, userId: "manager-a", landlordId: "manager-a", email: "manager@example.test" } as unknown as AgentContext;
let rows: ManagerSmsResidentConversation[];
const input = { conversationKey: "manager-a:prospect:+12065550123", body: "Yes, the room is available." };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = "submitted";
  rows = [{
    conversationKey: input.conversationKey, ownerManagerUserId: "manager-a", phone: "+12065550123",
    residentUserId: null, residentEmail: null, name: "Potential tenant", propertyLabel: null,
    counterpartyRole: "prospect", messages: [{ id: "inbound-1", direction: "inbound", body: "Is the room available?",
      fromPhone: "+12065550123", toPhone: "+12065550100", messageSid: null, source: "work_number", createdAt: "2026-09-08" }],
  }];
  mocks.scope.mockResolvedValue(["manager-a"]);
  mocks.smsScope.mockResolvedValue(["manager-a"]);
  mocks.fetch.mockImplementation(async (_db, _actor, options) => ({ residents: rows.filter((row) =>
    !options?.scopeManagerIdsOverride || options.scopeManagerIdsOverride.includes(row.ownerManagerUserId)),
  }));
  mocks.audit.mockResolvedValue({ recorded: true });
  mocks.enqueue.mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "queued" });
  mocks.dispatch.mockResolvedValue({ submitted: 1, unknown: 0 });
});

describe("assistant work-number conversations", () => {
  it("finds a phone-only prospect by formatted phone and reads fenced messages", async () => {
    const found = await listSmsConversationsTool.handler(ctx, { q: "(206) 555-0123", limit: 30 });
    expect(found.count).toBe(1);
    expect(found.conversations[0]).toMatchObject({ phone: "+12065550123", email: null });
    const read = await listSmsConversationsTool.handler(ctx, { conversationKey: input.conversationKey, limit: 30 });
    expect(read.conversations[0]?.messages?.[0]?.body.untrustedContent).toContain("<<<EXTERNAL_SMS>>>");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("previews without sending, then sends the confirmed prospect text through the manual outbox", async () => {
    const preview = await previewWrite(replyToSmsConversationTool, ctx, input);
    expect(preview.ok).toBe(true);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    if (!preview.ok) throw new Error(preview.error);
    const sent = await executeWrite(replyToSmsConversationTool, ctx, preview.input);
    expect(sent.ok).toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      managerUserId: "manager-a", actorUserId: "manager-a", recipientPhone: "+12065550123",
      recipientEmail: null, recipientUserId: null, counterpartyRole: "prospect",
      conversationKey: input.conversationKey, purpose: "manager_conversation", body: input.body,
    }));
    expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0]!);
    expect(mocks.track).toHaveBeenCalledWith("message_sent", "manager-a", { channel: "sms", owner_id: "manager-a" });
  });

  it("refuses foreign conversations and changed phones before audit or send", async () => {
    const foreign = await previewWrite(replyToSmsConversationTool, ctx, { ...input, conversationKey: "manager-b:prospect:+12065550123" });
    expect(foreign.ok).toBe(false);
    const preview = await previewWrite(replyToSmsConversationTool, ctx, input);
    if (!preview.ok) throw new Error(preview.error);
    rows[0]!.phone = "+12065559999";
    const sent = await executeWrite(replyToSmsConversationTool, ctx, preview.input);
    expect(sent.ok).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("rechecks edit access and fails closed on an empty delegated scope", async () => {
    const preview = await previewWrite(replyToSmsConversationTool, ctx, input);
    if (!preview.ok) throw new Error(preview.error);
    mocks.scope.mockResolvedValue([]);
    const sent = await executeWrite(replyToSmsConversationTool, ctx, preview.input);
    expect(sent.ok).toBe(false);
    const delegated = { ...ctx, managerSmsAccess: { mode: "delegated" } } as AgentContext;
    mocks.smsScope.mockResolvedValue([]);
    mocks.fetch.mockClear();
    expect((await listSmsConversationsTool.handler(delegated, { limit: 30 })).count).toBe(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("uses the granted conversation owner's number for a co-manager", async () => {
    rows[0]!.ownerManagerUserId = "manager-b";
    mocks.scope.mockResolvedValue(["manager-a", "manager-b"]);
    const sent = await executeWrite(replyToSmsConversationTool, ctx, { ...input, toPhone: "+12065550123" });
    expect(sent.ok).toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ managerUserId: "manager-b", actorUserId: "manager-a" }));
  });

  it("refuses sending if the audit write fails", async () => {
    mocks.audit.mockResolvedValue({ recorded: false });
    const sent = await executeWrite(replyToSmsConversationTool, ctx, { ...input, toPhone: "+12065550123" });
    expect(sent.ok).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("keeps prospect and resident conversations on a shared phone distinct", async () => {
    rows.unshift({ ...rows[0]!, conversationKey: "manager-a:resident:resident-1", counterpartyRole: "resident", residentUserId: "resident-1" });
    const sent = await executeWrite(replyToSmsConversationTool, ctx, { ...input, toPhone: "+12065550123" });
    expect(sent.ok).toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ conversationKey: input.conversationKey, counterpartyRole: "prospect", recipientUserId: null }));
  });

  it("rechecks a co-manager's edit grant in the shared send function", async () => {
    rows[0]!.ownerManagerUserId = "manager-b";
    const result = await sendManagerConversationSms(ctx.db, { actorUserId: ctx.userId,
      conversationKey: input.conversationKey, toPhone: "+12065550123", text: input.body });
    expect(result.status).toBe(403);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each(["recipient_opted_out", "scoped_consent_missing"])("preserves the %s consent refusal", async (error) => {
    mocks.enqueue.mockResolvedValue({ ok: false, error });
    const sent = await executeWrite(replyToSmsConversationTool, ctx, { ...input, toPhone: "+12065550123" });
    expect(sent.ok).toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it.each(["unknown", "blocked", "failed"])("does not report %s as sent", async (status) => {
    mocks.status = status;
    mocks.dispatch.mockResolvedValue({ submitted: 0, unknown: status === "unknown" ? 1 : 0 });
    const sent = await executeWrite(replyToSmsConversationTool, ctx, { ...input, toPhone: "+12065550123" });
    expect(sent.ok).toBe(false);
    if (!sent.ok && status === "unknown") expect(sent.error).toMatch(/do not resend/i);
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("reports a queued text as queued and prevents duplicate execution", async () => {
    mocks.status = "queued";
    mocks.dispatch.mockResolvedValue({ submitted: 0, unknown: 0 });
    const sent = await executeWrite(replyToSmsConversationTool, ctx, { ...input, toPhone: "+12065550123" });
    expect(sent.ok && sent.reply).toContain("queued");
    mocks.audit.mockResolvedValue({ recorded: false, duplicate: true });
    await executeWrite(replyToSmsConversationTool, ctx, { ...input, toPhone: "+12065550123" });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("never falls back to a different conversation when an explicit key is missing", async () => {
    const result = await sendManagerConversationSms(ctx.db, { actorUserId: ctx.userId,
      conversationKey: "deleted-conversation", toPhone: "+12065550123", text: input.body });
    expect(result.status).toBe(409);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
