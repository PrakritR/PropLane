// 75 team_chat_relay rows sat `queued` for two days (Nov 1-3): the relay enqueued but never dispatched, and the sms-outbox
// cron was only a daily safety net with a backlog ahead of them. The relay now hands each text to the dispatcher, and a
// manager-facing relay / notice that is still queued or deferred after 6 hours expires instead of blasting late.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb } from "../helpers/fake-table-db";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => ({ phoneNumber: "+15005550001", numberId: "line-ws1" }),
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/manager-assistant-workspace.server")>()),
  userDefaultWorkspaceId: async () => "ws-1",
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/owner-sms-dispatcher.server")>()),
  enqueueOwnerSms: (...args: unknown[]) => mocks.enqueue(...args),
  dispatchOwnerSmsOutbox: (...args: unknown[]) => mocks.dispatch(...args),
}));

import { relayTeamChatMessageToSms } from "@/lib/team-comms.server";
import { expireStaleManagerNotices, STALE_MANAGER_NOTICE_REASON, STALE_MANAGER_NOTICE_TTL_MS } from "@/lib/sms/owner-sms-dispatcher.server";

const OWNER = "owner-1";
const verified = "2026-10-01T00:00:00.000Z";

const seed = () =>
  createFakeDb({
    portal_workspaces: [{ id: "ws-1", owner_user_id: OWNER, is_default: true, name: "Seattle" }],
    account_link_invites: [{ inviter_user_id: OWNER, invitee_user_id: "tm-1", status: "accepted", workspace_id: null, team_role: "admin" }],
    profiles: [
      { id: OWNER, phone: "+12065550100", phone_verified_at: verified },
      { id: "tm-1", phone: "+12065550101", phone_verified_at: verified },
    ],
    sms_outbox: [],
  });

const relay = (db: ReturnType<typeof seed>) =>
  relayTeamChatMessageToSms(db as unknown as SupabaseClient, {
    ownerManagerUserId: OWNER, workspaceId: "ws-1", senderUserId: "tm-1", senderName: "Tee", text: "hello", messageId: "m1",
  });

describe("the team relay hands each text to the dispatcher", () => {
  beforeEach(() => {
    mocks.enqueue.mockReset().mockResolvedValue({ ok: true, outboxId: "ob-1", status: "queued", deduplicated: false });
    mocks.dispatch.mockReset().mockResolvedValue({ ok: true, claimed: 1, submitted: 1, blocked: 0, unknown: 0, infrastructureErrors: [] });
  });

  it("dispatches the new outbox row by id right after enqueue", async () => {
    const outcomes = await relay(seed());
    expect(outcomes).toEqual([{ memberUserId: OWNER, status: "sent" }]);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch.mock.calls[0]![0]).toMatchObject({ outboxId: "ob-1" });
  });

  it("does not dispatch a deduplicated replay (it was already handed over the first time)", async () => {
    mocks.enqueue.mockResolvedValue({ ok: true, outboxId: "ob-1", status: "submitted", deduplicated: true });
    await relay(seed());
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("a dispatcher failure leaves the row queued for the cron and never fails the chat", async () => {
    mocks.dispatch.mockRejectedValue(new Error("boom"));
    await expect(relay(seed())).resolves.toEqual([{ memberUserId: OWNER, status: "sent" }]);
  });
});

describe("expireStaleManagerNotices", () => {
  function recorder(result: { data: unknown; error: unknown }) {
    const calls: Array<[string, unknown[]]> = [];
    const q: Record<string, unknown> = new Proxy({}, {
      get: (_t, name: string) => (name === "then"
        ? (resolve: (v: unknown) => void) => resolve(result)
        : (...args: unknown[]) => { calls.push([name, args]); return q; }),
    });
    return { db: { from: (table: string) => { calls.push(["from", [table]]); return q; } } as unknown as SupabaseClient, calls };
  }

  it("blocks queued / deferred, never-started relays and notices older than 6 hours with a clear reason", async () => {
    const now = new Date("2026-11-03T12:00:00.000Z");
    const { db, calls } = recorder({ data: [{ id: "a" }, { id: "b" }], error: null });
    await expect(expireStaleManagerNotices(db, now)).resolves.toBe(2);
    const named = Object.fromEntries(calls.map(([name, args]) => [name, args]));
    expect(named.from).toEqual(["sms_outbox"]);
    expect(named.update![0]).toMatchObject({ status: "blocked", blocked_reason: STALE_MANAGER_NOTICE_REASON });
    expect(STALE_MANAGER_NOTICE_REASON).toBe("expired_stale");
    expect(named.in).toEqual(["status", ["queued", "deferred"]]);
    expect(named.is).toEqual(["dispatch_started_at", null]);
    expect(named.lt).toEqual(["created_at", new Date(now.getTime() - STALE_MANAGER_NOTICE_TTL_MS).toISOString()]);
    // A notice still waiting on its own window (budget-deferred to the next UTC day) is held, not expired.
    expect(named.lte).toEqual(["available_at", now.toISOString()]);
    expect(STALE_MANAGER_NOTICE_TTL_MS).toBe(6 * 60 * 60_000);
    expect(String(named.or![0])).toContain("team_chat_relay");
    expect(String(named.or![0])).toContain("manager_agent_notification_");
  });

  it("an unreadable outbox expires nothing and never throws", async () => {
    await expect(expireStaleManagerNotices(recorder({ data: null, error: { code: "XX000" } }).db)).resolves.toBe(0);
  });
});
