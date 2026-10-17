import { describe, expect, it } from "vitest";
import {
  collapsePersonInboxThreads,
  personConversationTitle,
  type InboxThreadMessage,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import {
  INBOX_ATTACHMENT_FAILED_MESSAGE,
  inboxAttachmentsAllowSend,
  inboxAttachmentsHaveFailure,
} from "@/lib/inbox-attachment-send-gate";
import { aiDraftFieldsAfterReply } from "@/lib/communication/shared-thread-merge";
import { buildTeamNoticeLine } from "@/lib/team-notice-line";
import { inboxThreadLastTurnDirection } from "@/lib/inbox-turn-direction";
import { composeRecipientSummary } from "@/lib/compose-recipient-summary";
import { assistantEmailUrl } from "@/lib/manager-assistant-email/assistant-email-url";

function thread(over: Partial<PersistedInboxThread> & { id: string }): PersistedInboxThread {
  return {
    folder: "sent",
    from: "Test Manager",
    email: "resident@example.test",
    subject: "Update",
    preview: "",
    body: "Charge created",
    time: "Oct 14, 2026, 9:00 AM",
    unread: false,
    ...over,
  };
}

describe("C4: a merged person conversation is titled by the counterparty", () => {
  it("does not title the row with the manager's own name when the first turn is their automated notice", () => {
    const sentCopy = thread({
      id: "msg_mgr_sent",
      folder: "sent",
      rootOutbound: true,
      rootAutomated: true,
      rootAt: "Oct 14, 2026, 9:00 AM",
      time: "Oct 14, 2026, 9:00 AM",
    });
    const residentReply = thread({
      id: "msg_inbox_reply",
      folder: "inbox",
      from: "Rae Resident",
      rootOutbound: false,
      body: "Thanks",
      rootAt: "Oct 14, 2026, 9:30 AM",
      time: "Oct 14, 2026, 9:30 AM",
      unread: true,
    });
    const [row] = collapsePersonInboxThreads([sentCopy, residentReply], { mergeFolders: true });
    expect(row!.from).toBe("Rae Resident");
  });

  it("falls back to the address's name when no inbound turn exists yet", () => {
    const only = thread({ id: "msg_only", folder: "sent", rootOutbound: true, rootAt: "Oct 14, 2026, 9:00 AM" });
    const ordered: InboxThreadMessage[] = [{ id: "msg_only-root", from: "Test Manager", body: "Hi", at: "Oct 14, 2026, 9:00 AM", outbound: true }];
    expect(personConversationTitle(ordered[0]!, ordered, only)).toBe("Resident");
  });

  it("keeps the inbound sender when the first turn is theirs", () => {
    const first: InboxThreadMessage = { id: "a", from: "Rae Resident", body: "Hi", at: "x", outbound: false };
    expect(personConversationTitle(first, [first], thread({ id: "a", folder: "inbox" }))).toBe("Rae Resident");
  });
});

describe("C6: a failed attachment blocks the send", () => {
  it("blocks while any attachment failed, even with others ready", () => {
    expect(inboxAttachmentsHaveFailure([{ uploading: false }, { error: "Upload failed" }])).toBe(true);
    expect(inboxAttachmentsAllowSend([{}, { error: "Upload failed" }])).toBe(false);
    expect(INBOX_ATTACHMENT_FAILED_MESSAGE).toMatch(/failed/i);
  });
  it("blocks while uploading and allows none or all-ready", () => {
    expect(inboxAttachmentsAllowSend([{ uploading: true }])).toBe(false);
    expect(inboxAttachmentsAllowSend([])).toBe(true);
    expect(inboxAttachmentsAllowSend(undefined)).toBe(true);
    expect(inboxAttachmentsAllowSend([{}, {}])).toBe(true);
  });
});

describe("C5: a sent reply consumes the AI draft", () => {
  const draft = { text: "Sure", status: "pending_approval", generatedAt: "t1" };
  it("removes the pending draft", () => {
    expect(aiDraftFieldsAfterReply({ aiDraft: draft })).toEqual({ aiDraft: undefined, aiDraftQueue: undefined });
  });
  it("promotes the next queued draft", () => {
    const next = { text: "Later", status: "pending_approval", generatedAt: "t2" };
    const rest = { text: "Last", status: "pending_approval", generatedAt: "t3" };
    expect(aiDraftFieldsAfterReply({ aiDraft: draft, aiDraftQueue: [next, rest] })).toEqual({ aiDraft: next, aiDraftQueue: [rest] });
  });
  it("touches nothing on a row with no draft", () => {
    expect(aiDraftFieldsAfterReply({ body: "x" })).toEqual({});
  });
});

describe("C7: Team chat notices", () => {
  it("is one plain sentence for a charge, with no dots and no 'Payment update' tail", () => {
    const line = buildTeamNoticeLine({
      domain: "payment",
      event: "charge_created",
      subject: "Kitchen faucet drip · Payment update",
      amount: "$140",
      who: "Test Manager",
    });
    expect(line).toBe("Charge created: Kitchen faucet drip, $140, Test Manager.");
    expect(line).not.toContain("·");
  });
  it("says service request for a work order and keeps the emergency prefix", () => {
    expect(buildTeamNoticeLine({ domain: "work_order", event: "created", subject: "Access or lock issue", place: "5257 Brooklyn R2", who: "Khue" })).toBe(
      "Service request filed: Access or lock issue, 5257 Brooklyn R2, Khue.",
    );
    expect(buildTeamNoticeLine({ domain: "work_order", event: "created", subject: "x", urgent: true })).toBe("Emergency. Service request filed: x.");
    expect(buildTeamNoticeLine({ domain: "work_order", event: "vendor_assigned", subject: "x" })).not.toMatch(/work order/i);
  });
  it("a PropLane line in the Team chat is not 'You:'", () => {
    const team = {
      id: "team-thread:owner:ws:w1",
      folder: "inbox" as const,
      from: "Team",
      email: "",
      subject: "Team",
      preview: "",
      body: "Welcome",
      time: "t",
      unread: false,
      rootOutbound: true,
      messages: [{ id: "n1", from: "PropLane", body: "Charge created: x.", at: "t", outbound: true }],
    };
    expect(inboxThreadLastTurnDirection(team)).not.toBe("outbound");
  });
});

describe("C10: typed recipients are listed", () => {
  it("lists picked people then typed addresses", () => {
    expect(composeRecipientSummary(["Rae Resident"], [{ label: "a@b.co" }, { label: "+1 206 555 0100" }])).toBe(
      "Rae Resident, a@b.co, +1 206 555 0100",
    );
    expect(composeRecipientSummary([], [{ label: "a@b.co" }])).toBe("a@b.co");
    expect(composeRecipientSummary([], [])).toBe("");
  });
});

describe("C12: one url per workspace for the work email", () => {
  it("keys on the workspace and is bare without one", () => {
    expect(assistantEmailUrl("ws 1")).toBe("/api/manager/assistant-email?workspaceId=ws%201");
    expect(assistantEmailUrl(null)).toBe("/api/manager/assistant-email");
  });
});
