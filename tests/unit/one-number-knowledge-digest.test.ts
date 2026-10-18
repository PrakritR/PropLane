import { beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeFakeDb } from "../helpers/knowledge-fake-db";

const notify = vi.hoisted(() => vi.fn(async () => ({ delivered: true, suppressed: false })));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notify }));

import { buildDigestText, isoWeekKey, runWeeklyKnowledgeDigest, topUnanswered } from "@/lib/one-number/knowledge/weekly-digest.server";

beforeEach(() => notify.mockClear());

describe("digest helpers", () => {
  it("keys one digest per ISO week", () => {
    expect(isoWeekKey(new Date("2026-10-18T12:00:00Z"))).toBe("2026-W42");
    expect(isoWeekKey(new Date("2026-10-19T12:00:00Z"))).toBe("2026-W43");
    expect(isoWeekKey(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
  });

  it("groups repeated questions and puts the most asked first", () => {
    const top = topUnanswered(["Is there a gym?", "is there a gym", "Where is the kayak rack?", "Is there a gym?!"]);
    expect(top[0]).toEqual({ question: "Is there a gym?", count: 3 });
    expect(top).toHaveLength(2);
    expect(topUnanswered(Array.from({ length: 12 }, (_, i) => `question number ${i}`), 5)).toHaveLength(5);
  });

  it("writes plain text with no long dashes and no emoji", () => {
    const text = buildDigestText([{ question: "Is there a gym?", count: 2 }], 1);
    expect(text).toContain("1. Is there a gym? (2 times)");
    expect(text).toContain("1 saved-answer suggestion waiting");
    expect(text).not.toMatch(/[—–]/u);
  });
});

describe("weekly digest", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const recent = "2026-10-15T00:00:00Z";
  const seed = () => ({
    sms_escalated_questions: [
      { workspace_id: "ws-a", owner_user_id: "ownerA", question: "Is there a gym?", entry_id: null, escalated_at: recent },
      { workspace_id: "ws-a", owner_user_id: "ownerA", question: "Is there a gym?", entry_id: null, escalated_at: recent },
      { workspace_id: "ws-a", owner_user_id: "ownerA", question: "Bike room?", entry_id: "e-approved", escalated_at: recent },
      { workspace_id: "ws-b", owner_user_id: "ownerB", question: "Pool hours?", entry_id: null, escalated_at: recent },
      { workspace_id: "ws-c", owner_user_id: "ownerC", question: "Old question", entry_id: null, escalated_at: "2026-09-01T00:00:00Z" },
    ],
    property_knowledge_entries: [{ id: "e-approved", workspace_id: "ws-a", status: "approved" }],
  });

  it("sends each team only its own unanswered questions, once a week", async () => {
    const fake = knowledgeFakeDb(seed());
    const result = await runWeeklyKnowledgeDigest(fake.db, now);
    expect(result).toEqual({ sent: 2, skipped: 0 });
    const byOwner = Object.fromEntries(notify.mock.calls.map((c: any[]) => [c[1].landlordId, c[1]]));
    expect(byOwner.ownerA.text).toContain("Is there a gym? (2 times)");
    expect(byOwner.ownerA.text).not.toContain("Bike room");
    expect(byOwner.ownerA.text).not.toContain("Pool hours");
    expect(byOwner.ownerB.text).toContain("Pool hours");
    expect(byOwner.ownerB.text).not.toContain("gym");
    expect(byOwner.ownerA.workspaceId).toBe("ws-a");
    expect(JSON.stringify(notify.mock.calls)).not.toContain("Old question");

    notify.mockClear();
    expect(await runWeeklyKnowledgeDigest(fake.db, now)).toEqual({ sent: 0, skipped: 2 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("a team with everything answered gets no digest", async () => {
    const fake = knowledgeFakeDb({
      sms_escalated_questions: [{ workspace_id: "ws-a", owner_user_id: "ownerA", question: "Bike room?", entry_id: "e1", escalated_at: "2026-10-15T00:00:00Z" }],
      property_knowledge_entries: [{ id: "e1", workspace_id: "ws-a", status: "approved" }],
    });
    expect(await runWeeklyKnowledgeDigest(fake.db, now)).toEqual({ sent: 0, skipped: 1 });
  });
});
