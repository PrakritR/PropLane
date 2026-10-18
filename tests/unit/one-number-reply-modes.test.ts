import { describe, expect, it } from "vitest";
import {
  applyManagerPick,
  correctionStats,
  decideNextMode,
  isCorrection,
  minMode,
  type ReplyOutcomeKind,
} from "@/lib/one-number/knowledge/reply-modes";
import { gateAiReply, loadTopicModes, resolveEffectiveMode, runReplyModeSweep, setTopicCeiling, rejectDraft, reviewAutoReply } from "@/lib/one-number/knowledge/reply-modes.server";
import { REPLY_TOPICS } from "@/lib/one-number/knowledge/topics";
import { knowledgeFakeDb } from "../helpers/knowledge-fake-db";

const NOW = new Date("2026-10-18T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const outcomes = (total: number, corrections: number): ReplyOutcomeKind[] =>
  Array.from({ length: total }, (_, i) => (i < corrections ? "edited" : "sent_as_is"));

describe("mode math", () => {
  it("treats edits, rejections and later corrections as corrections, not escalations", () => {
    expect(isCorrection("edited")).toBe(true);
    expect(isCorrection("rejected")).toBe(true);
    expect(isCorrection("corrected_after")).toBe(true);
    expect(isCorrection("sent_as_is")).toBe(false);
    expect(isCorrection("escalated")).toBe(false);
    expect(correctionStats(["escalated", "edited", "sent_as_is"])).toEqual({ total: 2, corrections: 1, rate: 0.5 });
  });

  it("promotes one step with 100 replies, under 2% corrections, and 14 days in the mode", () => {
    const row = { mode: "draft" as const, ceiling: "full_auto" as const, modeSince: daysAgo(20) };
    expect(decideNextMode(row, outcomes(100, 1), NOW)).toEqual({ next: "auto_review", reason: "promote" });
    expect(decideNextMode({ ...row, mode: "auto_review" }, outcomes(100, 0), NOW).next).toBe("full_auto");
  });

  it("holds without enough replies, too many corrections, or too few days", () => {
    const row = { mode: "draft" as const, ceiling: null, modeSince: daysAgo(20) };
    expect(decideNextMode(row, outcomes(99, 0), NOW).reason).toBe("hold");
    expect(decideNextMode(row, outcomes(100, 2), NOW).reason).toBe("hold");
    expect(decideNextMode({ ...row, modeSince: daysAgo(13) }, outcomes(100, 0), NOW).reason).toBe("hold");
  });

  it("never promotes past the manager's ceiling", () => {
    const row = { mode: "auto_review" as const, ceiling: "auto_review" as const, modeSince: daysAgo(30) };
    expect(decideNextMode(row, outcomes(100, 0), NOW).next).toBe("auto_review");
  });

  it("demotes one step when corrections pass 5%, and clamps a mode above the ceiling", () => {
    const row = { mode: "full_auto" as const, ceiling: "full_auto" as const, modeSince: daysAgo(1) };
    expect(decideNextMode(row, outcomes(100, 6), NOW)).toEqual({ next: "auto_review", reason: "demote" });
    expect(decideNextMode({ ...row, mode: "draft" }, outcomes(100, 30), NOW).next).toBe("draft");
    expect(decideNextMode({ ...row, ceiling: "draft" }, outcomes(10, 0), NOW)).toEqual({ next: "draft", reason: "clamp_to_ceiling" });
  });

  it("looks only at the last 100 outcomes", () => {
    const history = [...outcomes(100, 0), ...outcomes(50, 50)];
    expect(correctionStats(history).corrections).toBe(0);
  });

  it("a manager's pick can only lower today's full auto, never raise a lower mode", () => {
    expect(applyManagerPick(null, "draft")).toEqual({ mode: "draft", ceiling: "draft" });
    expect(applyManagerPick(null, "full_auto")).toEqual({ mode: "full_auto", ceiling: "full_auto" });
    expect(applyManagerPick({ mode: "draft" }, "full_auto")).toEqual({ mode: "draft", ceiling: "full_auto" });
    expect(minMode("auto_review", "draft")).toBe("draft");
  });
});

const WS = "ws-a";

describe("reply gate", () => {
  const send = (fake: ReturnType<typeof knowledgeFakeDb>, inboundText: string) =>
    gateAiReply(fake.db, { workspaceId: WS, ownerUserId: "owner", role: "resident", phone: "+12065550101", inboundText, replyText: "Trash is Tuesday." });

  it("a workspace that never picked a mode behaves exactly as before and records nothing", async () => {
    const fake = knowledgeFakeDb();
    const gate = await send(fake, "what day is trash");
    expect(gate).toMatchObject({ deliver: true, held: false });
    expect(fake.rows.sms_ai_reply_drafts ?? []).toEqual([]);
    expect(fake.rows.sms_ai_reply_outcomes ?? []).toEqual([]);
    expect(fake.rows.sms_topic_reply_modes ?? []).toEqual([]);
  });

  it("holds a draft-mode reply for the manager and sends nothing", async () => {
    const fake = knowledgeFakeDb({ sms_topic_reply_modes: [{ workspace_id: WS, topic: "utilities", mode: "draft", ceiling: null, mode_since: NOW.toISOString() }] });
    const gate = await send(fake, "what day is trash");
    expect(gate).toMatchObject({ deliver: false, held: true, topic: "utilities" });
    expect(fake.rows.sms_ai_reply_drafts).toHaveLength(1);
    expect(fake.rows.sms_ai_reply_drafts![0]).toMatchObject({ workspace_id: WS, status: "pending", mode: "draft", body: "Trash is Tuesday." });
  });

  it("sends an auto-review reply and flags it for review", async () => {
    const fake = knowledgeFakeDb({ sms_topic_reply_modes: [{ workspace_id: WS, topic: "utilities", mode: "auto_review", ceiling: null, mode_since: NOW.toISOString() }] });
    const gate = await send(fake, "what day is trash");
    expect(gate).toMatchObject({ deliver: true, held: false, mode: "auto_review" });
    expect(fake.rows.sms_ai_reply_drafts![0]).toMatchObject({ mode: "auto_review", status: "pending" });
  });

  it("counts a full-auto reply as an outcome", async () => {
    const fake = knowledgeFakeDb({ sms_topic_reply_modes: [{ workspace_id: WS, topic: "utilities", mode: "full_auto", ceiling: null, mode_since: NOW.toISOString() }] });
    expect(await send(fake, "what day is trash")).toMatchObject({ deliver: true, mode: "full_auto" });
    expect(fake.rows.sms_ai_reply_outcomes).toHaveLength(1);
    expect(fake.rows.sms_ai_reply_outcomes![0]).toMatchObject({ topic: "utilities", outcome: "sent_as_is" });
  });

  it("holds money, legal, safety and fair housing questions as drafts even on a full-auto topic", async () => {
    const fake = knowledgeFakeDb({ sms_topic_reply_modes: [{ workspace_id: WS, topic: "payment", mode: "full_auto", ceiling: null, mode_since: NOW.toISOString() }] });
    const gate = await send(fake, "I need a refund for the rent I paid twice");
    expect(gate).toMatchObject({ deliver: false, held: true });
  });

  it("a topic the opted-in workspace has not seen starts in draft, with the clock started", async () => {
    const fake = knowledgeFakeDb({ sms_topic_reply_modes: [{ workspace_id: WS, topic: "tour", mode: "full_auto", ceiling: null, mode_since: NOW.toISOString() }] });
    const effective = await resolveEffectiveMode(fake.db, { workspaceId: WS, topic: "parking" });
    expect(effective).toEqual({ mode: "draft", optedIn: true });
    expect(fake.rows.sms_topic_reply_modes!.find((r) => r.topic === "parking")).toMatchObject({ mode: "draft" });
  });

  it("fails open when the settings table is missing (code runs before the migration)", async () => {
    const fake = knowledgeFakeDb({}, { broken: ["sms_topic_reply_modes"] });
    expect(await send(fake, "what day is trash")).toMatchObject({ deliver: true, held: false });
  });

  it("delivers a draft-mode reply rather than lose it when the draft cannot be stored", async () => {
    const fake = knowledgeFakeDb(
      { sms_topic_reply_modes: [{ workspace_id: WS, topic: "utilities", mode: "draft", ceiling: null, mode_since: NOW.toISOString() }] },
      { broken: ["sms_ai_reply_drafts"] },
    );
    expect(await send(fake, "what day is trash")).toMatchObject({ deliver: true, held: false });
  });
});

describe("manager choices", () => {
  it("the first pick seeds every other topic at today's behaviour so nothing else flips to draft", async () => {
    const fake = knowledgeFakeDb();
    const row = await setTopicCeiling(fake.db, { workspaceId: WS, topic: "tour", pick: "draft" });
    expect(row).toMatchObject({ topic: "tour", mode: "draft", ceiling: "draft" });
    const modes = await loadTopicModes(fake.db, WS);
    expect(modes).toHaveLength(REPLY_TOPICS.length);
    expect(modes.filter((m) => m.topic !== "tour").every((m) => m.mode === "full_auto")).toBe(true);
  });

  it("rejecting a draft and reviewing an auto reply record the right outcomes", async () => {
    const fake = knowledgeFakeDb({
      sms_ai_reply_drafts: [
        { id: "d1", workspace_id: WS, topic: "tour", mode: "draft", status: "pending" },
        { id: "d2", workspace_id: WS, topic: "tour", mode: "auto_review", status: "pending" },
      ],
    });
    expect(await rejectDraft(fake.db, { workspaceId: WS, draftId: "d1" })).toBe(true);
    expect(await rejectDraft(fake.db, { workspaceId: WS, draftId: "d1" })).toBe(false);
    expect(await reviewAutoReply(fake.db, { workspaceId: WS, draftId: "d2", verdict: "corrected" })).toBe(true);
    expect(fake.rows.sms_ai_reply_outcomes!.map((o) => o.outcome)).toEqual(["rejected", "corrected_after"]);
  });

  it("a draft from another workspace cannot be touched", async () => {
    const fake = knowledgeFakeDb({ sms_ai_reply_drafts: [{ id: "d1", workspace_id: "ws-b", topic: "tour", mode: "draft", status: "pending" }] });
    expect(await rejectDraft(fake.db, { workspaceId: WS, draftId: "d1" })).toBe(false);
  });
});

describe("nightly sweep", () => {
  it("promotes a clean topic, demotes a corrected one and leaves others alone", async () => {
    const old = daysAgo(30).toISOString();
    const fake = knowledgeFakeDb({
      sms_topic_reply_modes: [
        { workspace_id: WS, topic: "tour", mode: "draft", ceiling: "full_auto", mode_since: old },
        { workspace_id: WS, topic: "pricing", mode: "full_auto", ceiling: "full_auto", mode_since: old },
        { workspace_id: WS, topic: "parking", mode: "draft", ceiling: "full_auto", mode_since: old },
      ],
      sms_ai_reply_outcomes: [
        ...Array.from({ length: 100 }, (_, i) => ({ workspace_id: WS, topic: "tour", outcome: "sent_as_is", created_at: `2026-10-${String(1 + (i % 17)).padStart(2, "0")}T00:00:00Z` })),
        ...Array.from({ length: 100 }, (_, i) => ({ workspace_id: WS, topic: "pricing", outcome: i < 10 ? "edited" : "sent_as_is", created_at: "2026-10-10T00:00:00Z" })),
      ],
    });
    const result = await runReplyModeSweep(fake.db, NOW);
    expect(result.moves.map((m) => `${m.topic}:${m.from}>${m.to}`).sort()).toEqual(["pricing:full_auto>auto_review", "tour:draft>auto_review"]);
    expect(fake.rows.sms_topic_reply_modes!.find((r) => r.topic === "parking")!.mode).toBe("draft");
  });

  it("expires stale auto-review flags as accepted", async () => {
    const fake = knowledgeFakeDb({
      sms_ai_reply_drafts: [{ id: "old", workspace_id: WS, topic: "tour", mode: "auto_review", status: "pending", created_at: daysAgo(5).toISOString() }],
    });
    const result = await runReplyModeSweep(fake.db, NOW);
    expect(result.expired).toBe(1);
    expect(fake.rows.sms_ai_reply_drafts![0]!.status).toBe("reviewed");
    expect(fake.rows.sms_ai_reply_outcomes![0]).toMatchObject({ outcome: "sent_as_is", mode: "auto_review" });
  });
});
