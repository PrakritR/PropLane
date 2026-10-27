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

describe("the home lock on the session", () => {
  it("a route save can set the lock, leaves it alone when not asked, and clears it with null", async () => {
    const { db } = fakeSharedLineDb();
    expect((await loadSharedLineSession(db, "k"))?.lockedPropertyId ?? null).toBeNull();
    await saveSharedLineRoute(db, "k", { workspaceId: "ws-a", role: "prospect", lockedPropertyId: "prop-1" });
    expect(await loadSharedLineSession(db, "k")).toMatchObject({ lockedPropertyId: "prop-1" });
    expect((await loadSharedLineSession(db, "k"))?.lockedAt).toBeTruthy();
    // An ordinary routed text never moves the lock.
    await saveSharedLineRoute(db, "k", { workspaceId: "ws-a", role: "prospect" });
    expect(await loadSharedLineSession(db, "k")).toMatchObject({ lockedPropertyId: "prop-1" });
    // The switch question rides pending_candidates and does not touch the lock either.
    await saveSharedLinePending(db, "k", [candidate]);
    expect(await loadSharedLineSession(db, "k")).toMatchObject({ lockedPropertyId: "prop-1", pendingCandidates: [expect.objectContaining({ workspaceId: "ws-a" })] });
    await saveSharedLineRoute(db, "k", { workspaceId: "ws-b", role: "prospect", lockedPropertyId: null });
    expect(await loadSharedLineSession(db, "k")).toMatchObject({ lockedPropertyId: null, lockedAt: null });
  });

  it("before the migration (no lock columns) the session still reads and the route still saves, without the lock", async () => {
    const rows: Record<string, unknown>[] = [];
    const missing = { code: "42703", message: "column does not exist" };
    const table = (name: string) => {
      let columns = "";
      const q: Record<string, unknown> = {
        select(c: string) { columns = c; return q; },
        eq() { return q; },
        limit() { return q; },
        async maybeSingle() {
          if (name !== "sms_line_sessions") return { data: null, error: null };
          return columns.includes("locked_property_id") ? { data: null, error: missing } : { data: rows[0] ?? null, error: null };
        },
        upsert(v: Record<string, unknown>) {
          if ("locked_property_id" in v) return Promise.resolve({ error: missing });
          rows.splice(0, rows.length, v);
          return Promise.resolve({ error: null });
        },
        then(resolve: (v: unknown) => unknown) { return resolve({ data: [], error: null }); },
      };
      return q;
    };
    const db = { from: table } as never;
    expect(await saveSharedLineRoute(db, "k", { workspaceId: "ws-a", role: "prospect", lockedPropertyId: "prop-1" })).toBe(true);
    expect(await loadSharedLineSession(db, "k")).toMatchObject({ currentWorkspaceId: "ws-a", lockedPropertyId: null });
  });
});
