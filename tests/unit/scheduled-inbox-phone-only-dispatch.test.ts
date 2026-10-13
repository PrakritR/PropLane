/** The dispatcher sends a phone-only scheduled record through the manual-reply SMS path. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: vi.fn() }));
vi.mock("@/lib/manager-sms-send.server", () => ({ sendManagerConversationSms: vi.fn() }));
vi.mock("@/lib/scheduled-inbox-messages.server", () => ({
  isResidentOriginatedScheduledMessage: vi.fn(() => false),
  loadScheduledInboxMessageForDelivery: vi.fn(),
}));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowedForWorkspace: vi.fn(async () => ({ allowed: true })),
}));

import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { sendManagerConversationSms } from "@/lib/manager-sms-send.server";
import { loadScheduledInboxMessageForDelivery } from "@/lib/scheduled-inbox-messages.server";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { sendScheduledInboxMessageNow } from "@/lib/send-scheduled-inbox-message-now";

const record = (): ScheduledInboxMessageRecord => ({
  id: "sched-phone-1", managerUserId: "owner-1", sendAt: "2026-10-14T16:00:00Z", status: "sending",
  subject: "Message for +1 (726) 248-3085", body: "See you Thursday", recipientEmail: "", recipientName: "+1 (726) 248-3085",
  recipientPhone: "+17262483085", conversationKey: "conv-1", recipientUserId: null,
  deliverViaInbox: false, deliverViaEmail: false, deliverViaSms: true, createdAt: "2026-10-13T12:00:00Z",
});

function fakeDb() {
  const statuses = new Map<string, string>();
  const rpc = vi.fn(async (name: string, args: Record<string, string>) => {
    if (name === "claim_scheduled_inbox_channel") {
      if (statuses.get(args.p_channel)) return { data: { outcome: statuses.get(args.p_channel), token: null }, error: null };
      statuses.set(args.p_channel, "claimed");
      return { data: { outcome: "claimed", token: `t-${args.p_channel}` }, error: null };
    }
    if (name === "resolve_scheduled_inbox_channel") { statuses.set(args.p_channel, args.p_status); return { data: true, error: null }; }
    return { data: ["inbox", "email", "sms"].every((c) => ["submitted", "skipped"].includes(statuses.get(c) ?? "")), error: null };
  });
  const db = { rpc, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "owner@example.com", full_name: "Owner" }, error: null }) }) }) }) };
  return { db: db as never, statuses };
}

describe("phone-only scheduled record delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadScheduledInboxMessageForDelivery).mockResolvedValue(record());
  });

  it("sends the Text through the manager conversation SMS path and nothing else", async () => {
    vi.mocked(sendManagerConversationSms).mockResolvedValue({ body: { ok: true, status: "submitted" }, status: 200 });
    const { db, statuses } = fakeDb();
    const result = await sendScheduledInboxMessageNow(db, record());
    expect(result.ok).toBe(true);
    expect(sendManagerConversationSms).toHaveBeenCalledTimes(1);
    expect(sendManagerConversationSms).toHaveBeenCalledWith(db, expect.objectContaining({
      actorUserId: "owner-1", toPhone: "+17262483085", text: "See you Thursday", conversationKey: "conv-1",
    }));
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
    expect(statuses.get("sms")).toBe("submitted");
    expect(statuses.get("email")).toBe("skipped");
  });

  it("records a refused send as failed", async () => {
    vi.mocked(sendManagerConversationSms).mockResolvedValue({ body: { error: "Messaging requires an active paid plan." }, status: 503 });
    const { db, statuses } = fakeDb();
    const result = await sendScheduledInboxMessageNow(db, record());
    expect(result.ok).toBe(false);
    expect(statuses.get("sms")).toBe("failed");
  });
});
