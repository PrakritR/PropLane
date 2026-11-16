import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "../helpers/fake-table-db";

vi.mock("@/lib/tools/audit", () => ({
  writeAuditLog: vi.fn(async () => ({ recorded: true })),
}));

import { writeAuditLog } from "@/lib/tools/audit";
import { loadAnswerableEntries } from "@/lib/one-number/knowledge/store.server";
import {
  correctReply,
  flagReply,
  isAssistantPaused,
  listOpenReviews,
  loadThreadReview,
  pauseAssistantThread,
  resumeAssistantThread,
  type ReviewActor,
} from "@/lib/assistant-review/store.server";
import { reviewKeyForThread, smsReviewThreadKey } from "@/lib/assistant-review/model";
import { isAssistantReplyTurn, lastInboundBefore } from "@/lib/assistant-review/turns";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

function actorFor(db: FakeDb, workspaceId = WS_A): ReviewActor {
  return { db: db as never, userId: "mgr-1", workspaceId, ownerUserId: "owner-1" };
}

let db: FakeDb;
beforeEach(() => {
  vi.clearAllMocks();
  db = createFakeDb({ assistant_thread_reviews: [], property_knowledge_entries: [], sms_line_thread_state: [],
    manager_property_records: [
      { id: "house-1", workspace_id: WS_A, manager_user_id: "owner-1", property_data: {}, row_data: {} },
      { id: "house-2", workspace_id: WS_A, manager_user_id: "owner-1", property_data: {}, row_data: {} },
      { id: "house-x", workspace_id: WS_B, manager_user_id: "owner-9", property_data: {}, row_data: {} },
    ] }) as never as FakeDb;
});

describe("flag a reply", () => {
  it("needs a reason and a reply, stores one open flag per reply, audits it", async () => {
    expect((await flagReply(actorFor(db), { threadKey: "t1", messageRef: "m1", reason: "" })).ok).toBe(false);
    expect((await flagReply(actorFor(db), { threadKey: "bad key", messageRef: "m1", reason: "wrong" })).ok).toBe(false);
    const first = await flagReply(actorFor(db), { threadKey: "t1", messageRef: "m1", reason: "Said parking is free", agentText: "Parking is free." });
    expect(first.ok).toBe(true);
    const again = await flagReply(actorFor(db), { threadKey: "t1", messageRef: "m1", reason: "Said parking is free" });
    expect(again.ok && first.ok && again.id === first.id).toBe(true);
    expect(db.tables.assistant_thread_reviews).toHaveLength(1);
    expect(db.tables.assistant_thread_reviews[0]).toMatchObject({ workspace_id: WS_A, kind: "flag", message_ref: "m1", created_by_user_id: "mgr-1" });
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeAuditLog).mock.calls[0]![1]).toMatchObject({ action: "assistant_reply_flag" });
  });
});

describe("correct a reply: house knowledge the assistant reads, never an instruction", () => {
  it("writes an approved knowledge entry in THIS workspace, keeps a note on the thread, resolves the flag", async () => {
    await flagReply(actorFor(db), { threadKey: "t1", messageRef: "m1", reason: "wrong" });
    const out = await correctReply(actorFor(db), {
      threadKey: "t1", messageRef: "m1", question: "Is parking included?", correction: "Street parking only, no garage.",
      propertyId: "house-1", audience: "all",
    });
    expect(out.ok).toBe(true);
    const entry = db.tables.property_knowledge_entries[0]!;
    expect(entry).toMatchObject({ workspace_id: WS_A, property_id: "house-1", status: "approved", answer: "Street parking only, no garage.", question: "Is parking included?", audience: "all" });
    const rows = db.tables.assistant_thread_reviews;
    expect(rows.find((r) => r.kind === "correction")).toMatchObject({ body: "Street parking only, no garage.", knowledge_entry_id: entry.id });
    expect(rows.find((r) => r.kind === "flag")!.resolved_at).toBeTruthy();
    const state = await loadThreadReview(db as never, WS_A, "t1");
    expect(state?.corrections).toHaveLength(1);
    expect(state?.flags[0]?.resolvedAt).toBeTruthy();
    // Another workspace sees none of it.
    expect((await loadThreadReview(db as never, WS_B, "t1"))?.corrections).toHaveLength(0);
  });

  it("the assistant READS the correction through the knowledge store, scoped to the workspace and audience (data, not an instruction)", async () => {
    await correctReply(actorFor(db), { threadKey: "t1", messageRef: "m1", question: "Is parking included?", correction: "Street parking only.", audience: "residents" });
    const mine = await loadAnswerableEntries(db as never, { workspaceId: WS_A, allowedPropertyIds: null, audiences: ["all", "residents", "team"] });
    expect(mine.map((e) => e.answer)).toEqual(["Street parking only."]);
    // Another workspace's assistant never reads it; neither does an audience it was not written for.
    expect(await loadAnswerableEntries(db as never, { workspaceId: WS_B, allowedPropertyIds: null, audiences: ["all", "residents", "team"] })).toEqual([]);
    expect(await loadAnswerableEntries(db as never, { workspaceId: WS_A, allowedPropertyIds: null, audiences: ["all"] })).toEqual([]);
  });

  it("refuses a house outside the workspace, and a delegated seat's team-wide or unassigned correction", async () => {
    const base = { threadKey: "t1", messageRef: "m1", question: "q", correction: "fixed" };
    expect(await correctReply(actorFor(db), { ...base, propertyId: "house-x", audience: "residents" })).toMatchObject({ ok: false, status: 403 });
    expect(await correctReply(actorFor(db), { ...base, propertyId: "nope", audience: "residents" })).toMatchObject({ ok: false, status: 403 });
    const delegated = { ...actorFor(db), allowedPropertyIds: ["house-1"] };
    expect(await correctReply(delegated, { ...base, audience: "residents" })).toMatchObject({ ok: false, status: 403 });
    expect(await correctReply(delegated, { ...base, propertyId: "house-2", audience: "residents" })).toMatchObject({ ok: false, status: 403 });
    expect(await correctReply(delegated, { ...base, propertyId: "house-1", audience: "all" })).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.property_knowledge_entries).toHaveLength(0);
    expect((await correctReply(delegated, { ...base, propertyId: "house-1", audience: "residents" })).ok).toBe(true);
    expect(db.tables.property_knowledge_entries).toHaveLength(1);
  });

  it("refuses an empty correction", async () => {
    const out = await correctReply(actorFor(db), { threadKey: "t1", messageRef: "m1", question: "q", correction: "   ", audience: "residents" });
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(db.tables.property_knowledge_entries).toHaveLength(0);
  });
});

describe("pause, resume and the paths that must honor it", () => {
  it("pausing is idempotent and scoped to the workspace", async () => {
    expect((await pauseAssistantThread(actorFor(db), { threadKey: "t1" })).ok).toBe(true);
    expect((await pauseAssistantThread(actorFor(db), { threadKey: "t1" })).ok).toBe(true);
    expect(db.tables.assistant_thread_reviews.filter((r) => r.kind === "pause")).toHaveLength(1);
    expect(await isAssistantPaused(db as never, { workspaceId: WS_A, threadKeys: ["t1"] })).toBe(true);
    // Another team's pause never applies, and an unrelated conversation is not paused.
    expect(await isAssistantPaused(db as never, { workspaceId: WS_B, threadKeys: ["t1"] })).toBe(false);
    expect(await isAssistantPaused(db as never, { workspaceId: WS_A, threadKeys: ["t2"] })).toBe(false);
  });

  it("any name the conversation goes by pauses it (its id or its conversation key)", async () => {
    await pauseAssistantThread(actorFor(db), { threadKey: "acct:resident-1" });
    expect(await isAssistantPaused(db as never, { workspaceId: WS_A, threadKeys: ["thread-9", "acct:resident-1"] })).toBe(true);
  });

  it("resume closes the pause and the assistant answers again", async () => {
    await pauseAssistantThread(actorFor(db), { threadKey: "t1" });
    await resumeAssistantThread(actorFor(db), { threadKey: "t1" });
    expect(await isAssistantPaused(db as never, { workspaceId: WS_A, threadKeys: ["t1"] })).toBe(false);
    expect(vi.mocked(writeAuditLog).mock.calls.map((c) => (c[1] as { action: string }).action)).toEqual(["assistant_thread_pause", "assistant_thread_resume"]);
  });

  it("a text thread's pause is mirrored to the line's own state and honored by it (HUMAN pauses show here too)", async () => {
    const key = smsReviewThreadKey("+12065550188")!;
    expect(key).toBe("sms:2065550188");
    await pauseAssistantThread(actorFor(db), { threadKey: key, role: "resident" });
    expect(db.tables.sms_line_thread_state[0]).toMatchObject({ phone_key: "2065550188", workspace_id: WS_A, ai_paused: true, role: "resident" });
    await resumeAssistantThread(actorFor(db), { threadKey: key });
    expect(db.tables.sms_line_thread_state[0]).toMatchObject({ ai_paused: false });
    // A pause the line holds (a typed HUMAN) is a pause here.
    db.tables.sms_line_thread_state.push({ phone_key: "2065550199", workspace_id: WS_A, ai_paused: true, role: "prospect" });
    expect(await isAssistantPaused(db as never, { workspaceId: WS_A, threadKeys: ["sms:2065550199"] })).toBe(true);
  });

  it("fails closed on an unreadable store (the assistant stays quiet), open on a missing table", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ in: () => ({ limit: async () => ({ data: null, error: { code: "XX000", message: "boom" } }) }) }) }) }) }) }) };
    expect(await isAssistantPaused(broken as never, { workspaceId: WS_A, threadKeys: ["t1"] })).toBe(true);
    const missing = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ in: () => ({ limit: async () => ({ data: null, error: { code: "42P01", message: "relation does not exist" } }) }) }) }) }) }) }) };
    expect(await isAssistantPaused(missing as never, { workspaceId: WS_A, threadKeys: ["t1"] })).toBe(false);
  });
});

describe("the Assistant review list", () => {
  it("lists this workspace's open flags and pauses, not a resolved one or another workspace's", async () => {
    await flagReply(actorFor(db), { threadKey: "t1", messageRef: "m1", reason: "wrong" });
    await flagReply(actorFor(db), { threadKey: "t2", messageRef: "m2", reason: "rude" });
    await pauseAssistantThread(actorFor(db), { threadKey: "t3" });
    await flagReply(actorFor(db, WS_B), { threadKey: "t9", messageRef: "m9", reason: "other team" });
    await correctReply(actorFor(db), { threadKey: "t2", messageRef: "m2", question: "q", correction: "fixed", audience: "residents" });
    const rows = (await listOpenReviews(db as never, WS_A)) ?? [];
    expect(rows.map((r) => [r.threadKey, r.kind]).sort()).toEqual([["t1", "flag"], ["t3", "pause"]]);
  });
});

describe("turn helpers", () => {
  it("only an assistant ANSWER is a labeled bubble; a notice or an event card stays an activity row", () => {
    expect(isAssistantReplyTurn({ automated: true, author: "PropLane Assistant", eventTitle: "PropLane Assistant", direction: "outbound" })).toBe(true);
    expect(isAssistantReplyTurn({ automated: true, author: "PropLane Assistant", eventTitle: "Payment received", direction: "outbound" })).toBe(false);
    expect(isAssistantReplyTurn({ automated: false, author: "PropLane Assistant", eventTitle: "PropLane Assistant" })).toBe(false);
    expect(isAssistantReplyTurn({ automated: true, author: "Ambika", eventTitle: "PropLane Assistant" })).toBe(false);
  });

  it("finds what the person asked, and keys a text-origin thread as the text stream does", () => {
    const msgs = [
      { id: "a", body: "hi", direction: "inbound" },
      { id: "b", body: "Is parking included?", direction: "inbound" },
      { id: "c", body: "Yes.", direction: "outbound", automated: true },
    ];
    expect(lastInboundBefore(msgs, "c")).toBe("Is parking included?");
    expect(reviewKeyForThread({ id: "thread-1", conversationKey: "tel:+12065550188" })).toBe("sms:2065550188");
    expect(reviewKeyForThread({ id: "thread-1", conversationKey: "acct:u1" })).toBe("acct:u1");
    expect(reviewKeyForThread({ id: "thread-1" })).toBe("thread-1");
  });
});
