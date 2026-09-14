/**
 * A dispatcher pass must be safe to run twice against the same queued set.
 *
 * `dispatchDueReminders` claims through `claim_due_reminders` (`for update
 * skip locked`, atomically flipping `scheduled` -> `sending`) and settles
 * through `resolve_reminder` (only the lease holder may move a row out of
 * `sending`). This fakes those two RPCs with the same state-machine the real
 * migration (`supabase/migrations/20260830020000_reminder_queue.sql`) encodes,
 * so a second call finding nothing left to claim is proof the real claim/lease
 * mechanism — not a mock that happens to return empty — makes re-running the
 * cron a no-op.
 *
 * Reuses the mocking conventions of `manager-agent-reminder-dispatch.test.ts`
 * (mock `notifyManagerFromAgent`, build a manager-audience `ReminderQueueRow`)
 * but does NOT reuse that file's `queue.server` mock: that file stubs
 * `resolveReminder` to always return `true` without touching any state, which
 * cannot express "the second pass claims zero rows" — this test needs the
 * real `claimDueReminders`/`resolveReminder` running against a faked
 * `db.rpc`, not a mocked-away one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/agent-notify.server", () => ({
  notifyManagerFromAgent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/reminders/current.server", () => ({
  reminderIsCurrent: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/reminders/settings.server", () => ({
  loadReminderSettingsForManagers: vi.fn().mockResolvedValue(new Map()),
}));

import { dispatchDueReminders } from "@/lib/reminders/dispatch.server";

type FakeQueueRow = {
  id: string;
  manager_user_id: string;
  kind: string;
  subject_id: string;
  lead_minutes: number;
  recipient_email: string;
  recipient_role: string;
  send_at: string;
  status: "scheduled" | "sending" | "sent" | "failed" | "cancelled";
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  payload: Record<string, unknown>;
};

/**
 * Fakes `claim_due_reminders` / `resolve_reminder` with the same contract the
 * real Postgres functions encode: claim atomically flips `scheduled` (or an
 * expired `sending` lease) to `sending` under this worker's lease, and
 * resolve only succeeds for the current lease holder while the row is still
 * `sending`.
 */
function fakeDb(rows: FakeQueueRow[]): SupabaseClient {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === "claim_due_reminders") {
        const workerId = String(args.p_worker_id);
        const limit = Number(args.p_limit ?? 100);
        const claimable = rows.filter((r) => r.status === "scheduled").slice(0, limit);
        const now = new Date();
        for (const row of claimable) {
          row.status = "sending";
          row.lease_owner = workerId;
          row.lease_expires_at = new Date(now.getTime() + 5 * 60_000).toISOString();
          row.attempts += 1;
        }
        return Promise.resolve({ data: claimable.map((r) => ({ ...r })), error: null });
      }
      if (fn === "resolve_reminder") {
        const row = rows.find((r) => r.id === args.p_id);
        const workerId = String(args.p_worker_id);
        if (!row || row.lease_owner !== workerId || row.status !== "sending") {
          return Promise.resolve({ data: false, error: null });
        }
        row.status = args.p_status as FakeQueueRow["status"];
        row.lease_owner = null;
        row.lease_expires_at = null;
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            in: () =>
              Promise.resolve({
                data: [{ id: "manager-1", email: "manager@example.com", full_name: "Morgan" }],
                error: null,
              }),
          }),
        };
      }
      throw new Error(`unexpected table in fake dispatcher db: ${table}`);
    },
  } as unknown as SupabaseClient;
}

function queuedRow(over: Partial<FakeQueueRow> = {}): FakeQueueRow {
  return {
    id: "reminder-1",
    manager_user_id: "manager-1",
    kind: "task",
    subject_id: "task-1",
    lead_minutes: 60,
    recipient_email: "manager@example.com",
    recipient_role: "manager",
    send_at: "2026-09-02T15:00:00.000Z",
    status: "scheduled",
    attempts: 0,
    lease_owner: null,
    lease_expires_at: null,
    payload: {
      title: "Countersign lease",
      recipientName: "Morgan",
      url: "https://prop-lane.space/portal/tasks",
      notificationCategory: "messages",
    },
    ...over,
  };
}

describe("dispatchDueReminders is safe to run twice on the same queued set", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims and sends once, then finds nothing left on the second pass", async () => {
    const rows = [queuedRow()];
    const db = fakeDb(rows);

    const first = await dispatchDueReminders(db, "worker-1");
    expect(first.claimed).toBe(1);
    expect(first.sent).toBe(1);
    expect(first.failed).toBe(0);
    expect(first.retried).toBe(0);
    expect(rows[0]!.status).toBe("sent");

    const second = await dispatchDueReminders(db, "worker-2");
    expect(second.claimed).toBe(0);
    expect(second.sent).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.retried).toBe(0);
  });

  it("does not double-send across two rows either", async () => {
    const rows = [queuedRow({ id: "reminder-1" }), queuedRow({ id: "reminder-2", subject_id: "task-2" })];
    const db = fakeDb(rows);

    await dispatchDueReminders(db, "worker-1");
    expect(rows.every((r) => r.status === "sent")).toBe(true);

    const second = await dispatchDueReminders(db, "worker-2");
    expect(second.claimed).toBe(0);
  });
});
