/** A phone-only scheduled Text: found inline by phone / conversation key, and an update keeps its number. */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sms/sms-test-transport.server", () => ({ captureSmsTestDelivery: vi.fn(), currentSmsTestTransport: () => null }));
vi.mock("@/lib/sms/sms-test-provenance.server", () => ({ stampSmsTestProvenance: (x: unknown) => x }));

import { scheduledItemsForRecipient } from "@/lib/inbox-scheduled-thread";
import { updateScheduledInboxMessage } from "@/lib/scheduled-inbox-messages.server";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";

const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
const textRecord = (over: Partial<ScheduledInboxMessageRecord> = {}): ScheduledInboxMessageRecord => ({
  id: "s1", managerUserId: "m1", sendAt: tomorrow, status: "scheduled", subject: "Message for x", body: "Hi",
  recipientEmail: "", recipientPhone: "+17262483085", conversationKey: "conv-1", recipientName: "+1 (726) 248-3085",
  deliverViaInbox: false, deliverViaEmail: false, deliverViaSms: true, createdAt: tomorrow, ...over,
});

describe("scheduled bubble lookup for a phone-only thread", () => {
  it("matches by E.164-normalised phone", () => {
    const items = scheduledItemsForRecipient("", [textRecord()], [], undefined, { phone: "(726) 248-3085" });
    expect(items.map((i) => i.id)).toEqual(["s1"]);
    expect(items[0].channel).toBe("sms");
  });
  it("matches by conversation key and ignores other numbers", () => {
    expect(scheduledItemsForRecipient("", [textRecord()], [], undefined, { conversationKey: "conv-1" })).toHaveLength(1);
    expect(scheduledItemsForRecipient("", [textRecord()], [], undefined, { phone: "+12065550100", conversationKey: "other" })).toHaveLength(0);
    expect(scheduledItemsForRecipient("", [textRecord()], [])).toHaveLength(0);
  });
});

describe("updateScheduledInboxMessage on a phone-only record", () => {
  it("patches body and time and keeps phone, conversation and channels", async () => {
    let written: Record<string, unknown> | null = null;
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: "scheduled", row_data: { subject: "s", body: "old", recipientEmail: "", recipientPhone: "+17262483085", conversationKey: "conv-1", deliverViaSms: true, deliverViaEmail: false, deliverViaInbox: false, senderPortal: "manager" } }, error: null }) }) }) }),
        update: (u: Record<string, unknown>) => { written = u; return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
      }),
    } as never;
    const newTime = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await updateScheduledInboxMessage(db, "m1", "s1", { body: "new words", sendAt: newTime, recipientEmail: "evil@x.com", deliverViaEmail: true });
    const w = written as unknown as { send_at: string; row_data: Record<string, unknown> };
    expect(w.send_at).toBe(newTime);
    expect(w.row_data).toMatchObject({ body: "new words", recipientPhone: "+17262483085", conversationKey: "conv-1", recipientEmail: "", deliverViaSms: true, deliverViaEmail: false });
  });
});
