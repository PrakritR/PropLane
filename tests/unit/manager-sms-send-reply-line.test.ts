import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * S6: a manual reply (no projection) used to carry no work line, so the
 * dispatcher fell to the owner's DEFAULT workspace number. It now pins the line
 * the conversation came in on, and refuses when two lines exist and none places it.
 */
const enqueue = vi.hoisted(() => vi.fn());
const dispatch = vi.hoisted(() => vi.fn());
const fetchConversations = vi.hoisted(() => vi.fn());
vi.mock("@/lib/manager-sms-messages.server", () => ({
  fetchManagerSmsConversations: fetchConversations,
  resolveSmsScopeManagerIds: vi.fn(async () => ["owner-1"]),
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: enqueue, dispatchOwnerSmsOutbox: dispatch }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { sendManagerConversationSms } from "@/lib/manager-sms-send.server";

const db = () =>
  createMemoryDb({
    manager_sms_numbers: [
      { id: "n-a", manager_user_id: "owner-1", workspace_id: "ws-a", phone_number: "+12065550001" },
      { id: "n-b", manager_user_id: "owner-1", workspace_id: "ws-b", phone_number: "+14255550002" },
    ],
    manager_property_records: [{ id: "hB", manager_user_id: "owner-1", workspace_id: "ws-b" }],
    sms_outbox: [{ id: "outbox-1", status: "submitted" }],
  }) as never;

const conversation = (over: Record<string, unknown>) => ({
  ownerManagerUserId: "owner-1", residentUserId: "r1", residentEmail: "r@example.test", name: "R", phone: "+12065550142",
  propertyLabel: null, counterpartyRole: "resident", conversationKey: "K1", messages: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  enqueue.mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "queued" });
  dispatch.mockResolvedValue({ submitted: 1, unknown: 0 });
});

const send = () => sendManagerConversationSms(db(), { actorUserId: "owner-1", toPhone: "+12065550142", text: "Hello there", idempotencyKey: "reply_line_test_0001", conversationKey: "K1" });

describe("manager reply leaves from the conversation's own line (S6)", () => {
  it("a conversation that came in on workspace B's number replies from B", async () => {
    fetchConversations.mockResolvedValue({
      residents: [conversation({ messages: [{ id: "m1", direction: "inbound", source: "work_number", fromPhone: "+12065550142", toPhone: "+14255550002", body: "hi", createdAt: "2026-09-29T00:00:00Z" }] })],
    });
    const res = await send();
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ selectedWorkLineId: "n-b" }));
  });

  it("a house-less, line-less conversation with two lines is refused, not sent from the default", async () => {
    fetchConversations.mockResolvedValue({ residents: [conversation({})] });
    const res = await send();
    expect(res.status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("falls to the line of the workspace that holds the conversation's house", async () => {
    fetchConversations.mockResolvedValue({
      residents: [conversation({ houses: [{ propertyId: "hB", label: "House B", source: "residency" }] })],
    });
    const res = await send();
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ selectedWorkLineId: "n-b" }));
  });
});
