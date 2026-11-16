/**
 * Messaging works through PropLane with SMS switched off (captain, Nov 15: "so I can test as resident, manager, vendor,
 * admin"). The in-app path must never need a phone, a work number or an SMS transport to send or to answer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const deliver = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ ok: true as const, recipientCount: 1 })));
const notify = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ delivered: true, suppressed: false })));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: deliver }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notify }));
vi.mock("@/lib/agent/inbox-auto-respond.server", () => ({ autoRespondToResidentInboxMessage: vi.fn() }));
vi.mock("@/lib/automation-send-mode.server", () => ({ partyFacingAnswerHold: vi.fn() }));
vi.mock("@/lib/automated-messages-settings.server", () => ({ loadAutomatedMessageSettings: vi.fn() }));
vi.mock("@/lib/communication/conversation-key.server", () => ({ loadThreadConversation: vi.fn(async () => ({ conversationKey: null, workspaceId: "ws-1" })) }));
vi.mock("@/lib/manager-assistant-email/email-auto-reply-credit.server", () => ({ reserveEmailAutoReplyCredit: vi.fn(), finishEmailAutoReplyCredit: vi.fn() }));
vi.mock("@/lib/tools/resident-index", () => ({ buildResidentRegistry: vi.fn() }));

const SMS_TRANSPORT = /(proplane-sms-transport|sendFromManagerWorkNumber|twilio|sendSms\b|enqueueOwnerSms|sendManagerNotificationSms)/i;
const read = (path: string) => readFileSync(path, "utf8");

describe("the in-app message paths reach no SMS transport", () => {
  it.each([
    "src/lib/resident-thread-auto-reply.server.ts",
    "src/lib/admin-shared-inbox.server.ts",
    "src/lib/assistant-review/store.server.ts",
    "src/lib/assistant-review/route.server.ts",
    "src/app/api/portal/assistant-review/route.ts",
    "src/app/api/admin/assistant-review/route.ts",
    "src/app/open/thread/route.ts",
  ])("%s", (path) => {
    expect(read(path)).not.toMatch(SMS_TRANSPORT);
  });
});

describe("the resident conversation's assistant, with no phone and SMS off", () => {
  it("answers in the same in-app conversation: no SMS leg, no manager text, the manager is told by push + the inbox", async () => {
    const { residentThreadAutoReplyDeps } = await import("@/lib/resident-thread-auto-reply.server");
    const db = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "manager@example.com" } }) }) }) }),
    };
    const deps = residentThreadAutoReplyDeps(db as never);
    const input = { managerUserId: "mgr-1", residentUserId: "res-1", residentEmail: "res@example.com", residentName: "Alex", threadId: "t1", messageId: "m1", text: "x" };
    expect(await deps.deliver({ input, text: "Street parking only.", messageKey: "k1" })).toBe(true);
    const sent = deliver.mock.calls[0]![1] as Record<string, unknown>;
    expect(sent).toMatchObject({ toUserIds: ["res-1"], automated: true, subject: "PropLane Assistant" });
    // Never an SMS leg: the delivery's own default is "no SMS", and this call does not opt in.
    expect(sent.deliverViaSms).not.toBe(true);

    await deps.notifyManager({ input, reason: "unanswerable", workspaceId: "ws-1", messageKey: "k1" });
    const notice = notify.mock.calls[0]![1] as { notify: { push: boolean; sms: boolean }; url: string };
    expect(notice.notify).toEqual({ push: true, sms: false });
    // The notice opens THIS conversation, not the bare list.
    expect(notice.url).toBe("/portal/communication/active/t1");
  });
});
