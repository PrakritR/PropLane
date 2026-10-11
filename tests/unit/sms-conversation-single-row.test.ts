import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { reduceSmsNoticeRow, asNoticeMarker } from "@/lib/sms-notice-reduction";
import { communicationListRowName, isSmsNoticeInboxRow } from "@/lib/communication-list-row-name";
import { mergeUnifiedInboxItems, type UnifiedInboxListItem } from "@/lib/unified-inbox-merge";
import { collapsePersonInboxThreads, type PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { smsConversationDisplayName } from "@/lib/manager-sms-messages";
import { SMS_AUTO_REPLY_AUTHOR } from "@/lib/sms-auto-reply";

const PHONE = "+14259849697";
const marker = {
  sourceNamespace: "twilio:owner:ACx", sourceEventId: "SM1", ownerManagerUserId: "owner", counterpartyRole: "prospect",
  workLineId: "line", occurredAt: "2026-10-11T21:14:00.000Z",
  bodySha256: createHash("sha256").update("Hi I'm looking for a room").digest("hex"),
};
const noticeRow = () => ({
  id: "sms_notice_0366", folder: "inbox", from: PHONE, email: "", subject: `Text from ${PHONE}`, unread: true,
  body: "Hi I'm looking for a room", preview: "Hi I'm looking for a room", rootAt: "2:14 PM", time: "2:15 PM",
  rootMessageId: "leasing_SM1", rootOriginalSmsEvent: marker, threadType: "claw_leasing_sms", smsNoticePhone: PHONE,
  conversationKey: `tel:${PHONE}`, workspaceId: "ws-1",
  messages: [
    { id: "auto_reply_SM1", from: SMS_AUTO_REPLY_AUTHOR, outbound: true, channel: "sms", at: "2:15 PM",
      body: "5257 Brooklyn Ave has 9 rooms total" },
  ],
});
const projected = (m: ReturnType<typeof asNoticeMarker>) => Boolean(m && m.sourceEventId === "SM1");

describe("a projected SMS notice leaves no second row", () => {
  it("drops the notice when only the server's auto-reply echo remains", () => {
    expect(reduceSmsNoticeRow(noticeRow(), projected)).toBeNull();
  });

  it("drops a legacy echo authored with the Assistant's own name", () => {
    const row = noticeRow();
    row.messages = [{ ...row.messages[0]!, id: "x1", from: "PropLane Assistant" }];
    expect(reduceSmsNoticeRow(row, projected)).toBeNull();
  });

  it("keeps a manager annotation and never takes an assistant author as the row's sender", () => {
    const row = noticeRow();
    row.messages.push({ id: "note-1", from: PHONE, outbound: false as never, channel: "sms", at: "2:20 PM", body: "Called back" } as never);
    const reduced = reduceSmsNoticeRow(row, projected)!;
    expect(reduced.from).toBe(PHONE);
    expect(reduced.body).toBe("Called back");
    expect(reduced.messages).toEqual([]);
  });

  it("keeps the assistant echo while its original is not projected, and keeps `from` the counterparty", () => {
    const reduced = reduceSmsNoticeRow(noticeRow(), () => false)!;
    expect(reduced.from).toBe(PHONE);
    expect((reduced.messages as unknown[]).length).toBe(1);
  });

  it("never lets an assistant-authored turn become the row's sender when it is promoted", () => {
    const row = noticeRow();
    row.messages = [{ id: "m9", from: SMS_AUTO_REPLY_AUTHOR, channel: "sms", at: "2:30 PM", body: "hello" } as never];
    const reduced = reduceSmsNoticeRow(row, projected)!;
    expect(reduced.from).toBe(PHONE);
  });
});

describe("list naming", () => {
  const thread = (over: Partial<PersistedInboxThread> & Record<string, unknown>) =>
    ({ id: "sms_notice_1", folder: "inbox", from: PHONE, email: "", subject: "", preview: "", time: "", unread: true, ...over }) as PersistedInboxThread;

  it("titles a text thread by its number even when the last turn is the assistant's", () => {
    const t = thread({ from: SMS_AUTO_REPLY_AUTHOR, threadType: "claw_leasing_sms", smsNoticePhone: PHONE });
    expect(communicationListRowName(t, [], { useFrom: true })).toBe("+1 (425) 984-9697");
    const old = thread({ from: "PropLane Assistant", threadType: "claw_leasing_sms", smsNoticePhone: PHONE });
    expect(communicationListRowName(old, [], { useFrom: true })).toBe("+1 (425) 984-9697");
  });

  it("formats a raw phone sender", () => {
    expect(communicationListRowName(thread({ threadType: "claw_leasing_sms" }), [], { useFrom: true })).toBe("+1 (425) 984-9697");
  });

  it("keeps PropLane Assistant for the assistant conversations only", () => {
    expect(communicationListRowName(thread({ id: "agent_notice_u", from: "PropLane Assistant", threadType: "agent_notice" }), [], { useFrom: true })).toBe("PropLane Assistant");
    expect(communicationListRowName(thread({ id: "resident-agent-u", from: "PropLane Assistant", threadType: "resident_agent" }), [], { useFrom: true })).toBe("PropLane Assistant");
    expect(isSmsNoticeInboxRow(thread({ id: "agent_notice_u", threadType: "agent_notice" }))).toBe(false);
    expect(isSmsNoticeInboxRow(thread({ threadType: "claw_leasing_sms" }))).toBe(true);
  });

  it("names a person thread by the directory, else by the sender", () => {
    const t = thread({ id: "t1", from: "Maya Chen", email: "maya@example.com" });
    expect(communicationListRowName(t, [], { useFrom: true })).toBe("Maya Chen");
  });

  it("an SMS row's stored phrase name is never the title", () => {
    const base = { name: "looking for", directoryName: null, savedContactName: "looking for", propertyLabel: null, residentEmail: null, phone: PHONE };
    expect(smsConversationDisplayName(base)).toBe("+1 (425) 984-9697");
    expect(smsConversationDisplayName({ ...base, name: "Maya Chen", directoryName: "Maya Chen" })).toBe("Maya Chen");
    expect(smsConversationDisplayName({ ...base, name: "Maya", savedContactName: "Maya" })).toBe("Maya");
  });

  it("collapse never adopts an assistant author as the row's from", () => {
    const a = thread({ id: "sms_notice_a", conversationKey: `tel:${PHONE}`, workspaceId: "ws-1", threadType: "claw_leasing_sms", time: "2:14 PM",
      messages: [{ id: "a-root", from: SMS_AUTO_REPLY_AUTHOR, body: "reply", at: "2:15 PM", outbound: true }] } as never);
    const b = thread({ id: "sms_notice_b", conversationKey: `tel:${PHONE}`, workspaceId: "ws-1", threadType: "claw_leasing_sms", time: "2:16 PM" });
    const [merged] = collapsePersonInboxThreads([a, b], { mergeFolders: true });
    expect(communicationListRowName(merged!, [], { useFrom: true })).toBe("+1 (425) 984-9697");
  });
});

describe("one row per SMS conversation", () => {
  const key = `ck:ws-1:tel:${PHONE}`;
  const notice: UnifiedInboxListItem = {
    key: "email:sms_notice_0366", channel: "email", threadId: "sms_notice_0366", name: "+1 (425) 984-9697", preview: "You: 5257 Brooklyn Ave has 9 rooms",
    time: "2:15 PM", unread: true, unreadCount: 1, sortMs: 100, joinKeys: [key], smsNotice: true,
  };
  const projection: UnifiedInboxListItem = {
    key: "sms:proj-1", channel: "sms", threadId: "proj-1", name: "+1 (425) 984-9697", preview: "5257 Brooklyn Ave has 9 rooms total",
    time: "2:16 PM", unread: true, unreadCount: 1, sortMs: 200, joinKeys: [key],
  };

  it("folds the stored notice and the projection into one row, newest preview, unread once", () => {
    const rows = mergeUnifiedInboxItems([notice, projection]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.preview).toBe("5257 Brooklyn Ave has 9 rooms total");
    expect(rows[0]!.name).toBe("+1 (425) 984-9697");
    expect(rows[0]!.unread).toBe(true);
    expect(rows[0]!.unreadCount).toBe(1);
    expect(rows[0]!.memberKeys).toEqual(expect.arrayContaining(["email:sms_notice_0366", "sms:proj-1"]));
  });

  it("a read projection is not made unread by the notice's own stale flag", () => {
    const rows = mergeUnifiedInboxItems([notice, { ...projection, unread: false, unreadCount: undefined }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unread).toBe(false);
  });

  it("orders by the stamp: the newer conversation floats to the top", () => {
    const other: UnifiedInboxListItem = { ...projection, key: "sms:proj-2", threadId: "proj-2", joinKeys: ["ck:ws-1:tel:+15550001111"], sortMs: 300, name: "(555) 000-1111" };
    const rows = mergeUnifiedInboxItems([notice, projection, other]);
    expect(rows.map((row) => row.threadId)).toEqual(["proj-2", "proj-1"]);
  });
});
