import { describe, expect, it } from "vitest";
import {
  describePlan,
  planConversationMerges,
  redactKey,
  type BackfillInput,
  type BackfillRef,
  type BackfillRow,
} from "@/lib/communication/conversation-backfill";
import { PERSONAL_WORKSPACE_ID } from "@/lib/communication/conversation-key";

const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";
const M = "11111111-0000-4000-8000-00000000000a";
const W1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const W2 = "aaaaaaaa-0000-4000-8000-0000000000a2";

const ref = (key: string, workspaceId = W1, flagged: BackfillRef["flagged"] = null): BackfillRef => ({
  workspaceId,
  key,
  keys: [key],
  flagged,
});

function row(id: string, rowData: Record<string, unknown>, over: Partial<BackfillRow> = {}): BackfillRow {
  return {
    id,
    scope: MANAGER_SCOPE,
    owner_user_id: M,
    participant_email: null,
    thread_type: "portal_message",
    updated_at: "2026-09-20T00:00:00Z",
    conversation_key: null,
    workspace_id: null,
    row_data: { id, folder: "inbox", email: "r@x.co", from: "Resident", subject: "s", ...rowData },
    ...over,
  };
}

const sentCopy = row("msg_1", {
  folder: "sent",
  from: "Manager",
  body: "Welcome!",
  rootAt: "Sep 1, 9:00 AM",
  time: "Sep 1, 9:00 AM",
  rootOutbound: true,
  propertyId: "H1",
  propertyTitle: "4709A 8th Ave",
  messages: [{ id: "m-2", from: "Manager", body: "Lease is ready", at: "Sep 5, 9:00 AM", outbound: true }],
});
const inboxCopy = row(
  "msg_inbox_1",
  {
    folder: "inbox",
    body: "Thanks, one question",
    rootAt: "Sep 2, 9:00 AM",
    time: "Sep 8, 9:00 AM",
    rootOutbound: false,
    unread: true,
    messages: [{ id: "m-3", from: "Resident", body: "Never mind", at: "Sep 8, 9:00 AM", outbound: false }],
  },
  { updated_at: "2026-09-21T00:00:00Z", participant_email: "manager@x.co" },
);
const propertyChat = row(
  "property_mgr_abc",
  {
    folder: "inbox",
    body: "Is the second house open?",
    rootAt: "Sep 3, 9:00 AM",
    time: "Sep 3, 9:00 AM",
    propertyId: "H2",
    propertyTitle: "12 Cedar St",
    messages: [],
  },
  { updated_at: "2026-09-19T00:00:00Z" },
);

const inputs = (rows: BackfillRow[], key = "acct:r1"): BackfillInput[] => rows.map((r) => ({ row: r, ref: ref(key) }));

describe("planConversationMerges", () => {
  it("folds a sent copy, an inbox copy and a per-property chat into ONE conversation, newest id kept, old ids aliased", () => {
    const plan = planConversationMerges(inputs([sentCopy, inboxCopy, propertyChat]));
    expect(plan.actions).toHaveLength(1);
    const merge = plan.actions[0]!;
    if (merge.kind !== "merge") throw new Error("expected a merge");
    expect(merge.keepId).toBe("msg_inbox_1");
    expect(merge.absorbIds.sort()).toEqual(["msg_1", "property_mgr_abc"]);
    expect(merge.key).toBe("acct:r1");
    expect(merge.workspaceId).toBe(W1);
    expect(merge.rowData.aliasIds).toEqual(expect.arrayContaining(["msg_1", "property_mgr_abc"]));
    expect(merge.rowData.conversationKey).toBe("acct:r1");

    // Chronological: root is the earliest turn, the rest follow in order.
    expect(merge.rowData.body).toBe("Welcome!");
    expect(merge.rowData.rootOutbound).toBe(true);
    const later = (merge.rowData.messages as { id: string; body: string }[]).map((m) => m.body);
    expect(later).toEqual(["Thanks, one question", "Is the second house open?", "Lease is ready", "Never mind"]);
    expect(merge.turns).toBe(5);
    expect(merge.rowData.preview).toBe("Never mind");
    expect(merge.rowData.unread).toBe(true);
  });

  it("each turn keeps the house its source thread was about", () => {
    const plan = planConversationMerges(inputs([sentCopy, inboxCopy, propertyChat]));
    const merge = plan.actions[0]!;
    if (merge.kind !== "merge") throw new Error("expected a merge");
    const turns = [
      { id: merge.rowData.rootMessageId, houseId: merge.rowData.rootHouseId },
      ...(merge.rowData.messages as { id: string; houseId?: string }[]),
    ];
    const houseOf = (id: unknown) => turns.find((t) => t.id === id)?.houseId;
    expect(houseOf("msg_1-root")).toBe("H1");
    expect(houseOf("property_mgr_abc-root")).toBe("H2");
    expect(houseOf("m-2")).toBe("H1");
    // The inbox copy named no house.
    expect(houseOf("msg_inbox_1-root")).toBeUndefined();
    // The conversation no longer claims ONE house on the row.
    expect(merge.rowData.propertyId).toBeUndefined();
  });

  it("is idempotent: a second pass over the result plans nothing (two clean passes)", () => {
    const first = planConversationMerges(inputs([sentCopy, inboxCopy, propertyChat]));
    const merge = first.actions[0]!;
    if (merge.kind !== "merge") throw new Error("expected a merge");
    const merged = row(merge.keepId, merge.rowData, {
      participant_email: merge.participantEmail,
      thread_type: merge.threadType,
      conversation_key: merge.key,
      workspace_id: merge.workspaceId,
    });
    const second = planConversationMerges(inputs([merged]));
    expect(second.actions).toEqual([]);
  });

  it("never merges rows that resolve to different people, even with the same email-less shape", () => {
    const plan = planConversationMerges([
      { row: sentCopy, ref: ref("acct:r1") },
      { row: inboxCopy, ref: ref("tel:+15105551234") },
    ]);
    expect(plan.actions.map((a) => a.kind)).toEqual(["stamp", "stamp"]);
  });

  it("never merges the same person across workspaces", () => {
    const plan = planConversationMerges([
      { row: sentCopy, ref: ref("acct:r1", W1) },
      { row: inboxCopy, ref: ref("acct:r1", W2) },
    ]);
    expect(plan.actions.every((a) => a.kind === "stamp")).toBe(true);
  });

  it("never merges across owners or scopes", () => {
    const other = row("x", { body: "hi" }, { owner_user_id: "22222222-0000-4000-8000-00000000000b" });
    const plan = planConversationMerges([
      { row: sentCopy, ref: ref("acct:r1") },
      { row: other, ref: ref("acct:r1") },
    ]);
    expect(plan.actions.every((a) => a.kind === "stamp")).toBe(true);
  });

  it("an ambiguous (flagged) identity stands alone and is reported, never merged", () => {
    const flagged = { reason: "ambiguous_phone" as const, accountIds: ["a", "b"], phone: "+15105551234" };
    const plan = planConversationMerges([
      { row: sentCopy, ref: ref("tel:+15105551234", W1, flagged) },
      { row: inboxCopy, ref: ref("tel:+15105551234", W1, flagged) },
    ]);
    expect(plan.actions.every((a) => a.kind === "stamp")).toBe(true);
    expect(plan.skipped.map((s) => s.reason).every((r) => r.startsWith("ambiguous_phone"))).toBe(true);
  });

  it("an unresolved identity is left exactly as it is", () => {
    const plan = planConversationMerges([{ row: sentCopy, ref: null }]);
    expect(plan.actions).toEqual([]);
    expect(plan.skipped[0]?.reason).toMatch(/no identity/);
  });

  it("SMS notices and a vendor's own inbox are stamped, never folded", () => {
    const notice = row("sms_notice_deadbeef", { smsNoticePhone: "+15105551234", body: "hi" }, { thread_type: "sms_notice" });
    const notice2 = row("sms_notice_cafe", { smsNoticePhone: "+15105551234", body: "yo" }, { thread_type: "sms_notice" });
    const vendorOwn = row("vendor-inbound-sms:v:+1510", { body: "x" }, { scope: "axis_portal_inbox_vendor_v1" });
    const plan = planConversationMerges([
      { row: notice, ref: ref("tel:+15105551234") },
      { row: notice2, ref: ref("tel:+15105551234") },
      { row: vendorOwn, ref: ref("tel:+15105559999", PERSONAL_WORKSPACE_ID) },
    ]);
    expect(plan.actions.map((a) => a.kind)).toEqual(["stamp-row-data", "stamp-row-data", "stamp-row-data"]);
  });

  it("assistant, team, agent, admin and unverified-lead threads are skipped", () => {
    const plan = planConversationMerges(
      [
        row("agent_notice_1", {}, { thread_type: "agent_notice" }),
        row("team-thread:o", {}, { thread_type: "team" }),
        row("res-agent", {}, { thread_type: "resident_agent" }),
        row("admin-1", {}, { scope: "admin" }),
        row("lead:unverified", { unverifiedLead: true }),
      ].map((r) => ({ row: r, ref: ref("mail:x@y.co") })),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toHaveLength(5);
  });

  it("an archived duplicate folds into the live conversation, not the other way round", () => {
    const archived = row("old", { folder: "trash", previousFolder: "inbox", body: "old", rootAt: "Aug 1, 9:00 AM" }, { updated_at: "2026-08-01T00:00:00Z" });
    const live = row("live", { folder: "inbox", body: "new", rootAt: "Sep 1, 9:00 AM" }, { updated_at: "2026-09-01T00:00:00Z" });
    const plan = planConversationMerges(inputs([archived, live]));
    const merge = plan.actions[0]!;
    if (merge.kind !== "merge") throw new Error("expected a merge");
    expect(merge.keepId).toBe("live");
    expect(merge.rowData.folder).toBe("inbox");
  });

  it("prints a plan that names shapes, not people", () => {
    const plan = planConversationMerges(inputs([sentCopy, inboxCopy], "mail:resident@example.com"));
    const text = describePlan(plan).join("\n");
    expect(text).toMatch(/^MERGE /);
    expect(text).not.toContain("resident@example.com");
    expect(redactKey("tel:+15105551234")).toBe("tel:+1******34");
    expect(redactKey("acct:22222222-0000-4000-8000-00000000000b")).toBe("acct:22222222");
  });
});
