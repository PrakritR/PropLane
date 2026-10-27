import { describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/manager-sms-messages.server", () => ({ fetchManagerSmsConversations: vi.fn(), resolveSmsScopeManagerIds: vi.fn() }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: enqueue, dispatchOwnerSmsOutbox: dispatch }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { sendManagerConversationSms } from "@/lib/manager-sms-send.server";

describe("selected projection send", () => {
  it("pins the exact authorized work line through the existing outbox dispatcher", async () => {
    enqueue.mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "queued" });
    dispatch.mockResolvedValue({ submitted: 1, unknown: 0 });
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: "submitted" } }) }) }) }) } as never;
    const result = await sendManagerConversationSms(db, {
      actorUserId: "owner-1", author: "manager", toPhone: "+12065550142", text: "Exact line reply", idempotencyKey: "selected_line_test_01",
      selectedConversation: {
        projectionId: "projection-two", workLineId: "line-two", ownerManagerUserId: "owner-1",
        residentUserId: "resident-1", residentEmail: "resident@example.com", name: "Resident", phone: "+12065550142",
        propertyLabel: null, counterpartyRole: "resident", conversationKey: "K2", messages: [],
      },
    });
    expect(result.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ selectedWorkLineId: "line-two", recipientPhone: "+12065550142", conversationKey: "K2" }));
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

// A live signup trial has no Communication; these tests are about the send path itself, so the
// owner's plan is a paid one here. The trial refusal has its own tests (manager-communication-access).
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowed: vi.fn(async () => ({ allowed: true })),
  assertManagerCommunicationAllowedForWorkspace: vi.fn(async () => ({ allowed: true })),
}));
