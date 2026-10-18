import { describe, expect, it } from "vitest";
import type { SharedLineCandidate } from "@/lib/one-number/contracts";
import {
  loadSharedLineSession,
  loadThreadPause,
  pauseThreadAi,
  resumeThreadAi,
  saveSharedLinePending,
  saveSharedLineRoute,
} from "@/lib/one-number/session.server";
import { fakeSharedLineDb } from "../helpers/shared-line-fake-db";

const candidate: SharedLineCandidate = {
  workspaceId: "ws-a", ownerUserId: "owner-a", role: "resident", reason: "resident", propertyId: null, label: "5259 Brooklyn",
};

describe("shared line session", () => {
  it("round-trips the current team and role, and clears any pending question", async () => {
    const { db } = fakeSharedLineDb();
    await saveSharedLinePending(db, "k", [candidate]);
    expect((await loadSharedLineSession(db, "k"))?.pendingCandidates).toMatchObject([{ workspaceId: "ws-a" }]);
    await saveSharedLineRoute(db, "k", { workspaceId: "ws-a", role: "resident" });
    expect(await loadSharedLineSession(db, "k")).toMatchObject({ currentWorkspaceId: "ws-a", activeRole: "resident", pendingCandidates: null });
  });

  it("a pending question older than the TTL is dropped", async () => {
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const { db } = fakeSharedLineDb({
      sms_line_sessions: [{ phone_key: "k", pending_candidates: [candidate], pending_asked_at: old, updated_at: old }],
    });
    expect((await loadSharedLineSession(db, "k"))?.pendingCandidates).toBeNull();
  });

  it("a missing table reads as no session and a failed write reports false, never throws", async () => {
    const { db } = fakeSharedLineDb({}, { broken: ["sms_line_sessions", "sms_line_thread_state"] });
    expect(await loadSharedLineSession(db, "k")).toBeNull();
    expect(await saveSharedLineRoute(db, "k", { workspaceId: "ws-a", role: "resident" })).toBe(false);
    expect(await loadThreadPause(db, "k", "ws-a")).toBeNull();
  });
});

describe("HUMAN pause is per (phone, workspace)", () => {
  it("pauses one workspace's thread only, then a manager resumes it", async () => {
    const { db, rows } = fakeSharedLineDb();
    await pauseThreadAi(db, { phoneKey: "k", workspaceId: "ws-a", role: "resident", reason: "human_keyword" });
    expect(await loadThreadPause(db, "k", "ws-a")).toEqual({ role: "resident", reason: "human_keyword" });
    expect(await loadThreadPause(db, "k", "ws-b")).toBeNull();
    expect(await loadThreadPause(db, "other", "ws-a")).toBeNull();

    await resumeThreadAi(db, { phoneKey: "k", workspaceId: "ws-b", resumedBy: "mgr" });
    expect(await loadThreadPause(db, "k", "ws-a")).not.toBeNull();

    await resumeThreadAi(db, { phoneKey: "k", workspaceId: "ws-a", resumedBy: "mgr" });
    expect(await loadThreadPause(db, "k", "ws-a")).toBeNull();
    expect(rows.sms_line_thread_state[0]).toMatchObject({ ai_paused: false, resumed_by: "mgr" });
  });

  it("pausing twice is one row", async () => {
    const { db, rows } = fakeSharedLineDb();
    await pauseThreadAi(db, { phoneKey: "k", workspaceId: "ws-a", role: "vendor", reason: "human_keyword" });
    await pauseThreadAi(db, { phoneKey: "k", workspaceId: "ws-a", role: "vendor", reason: "manager_takeover" });
    expect(rows.sms_line_thread_state).toHaveLength(1);
  });
});
