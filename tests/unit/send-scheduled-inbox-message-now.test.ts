import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: vi.fn() }));
vi.mock("@/lib/scheduled-inbox-messages.server", () => ({
  isResidentOriginatedScheduledMessage: vi.fn(() => false),
  loadScheduledInboxMessageForDelivery: vi.fn(),
}));

import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { loadScheduledInboxMessageForDelivery } from "@/lib/scheduled-inbox-messages.server";
import type { ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { sendScheduledInboxMessageNow } from "@/lib/send-scheduled-inbox-message-now";

function message(status: "scheduled" | "sending" = "scheduled"): ScheduledInboxMessageRecord {
  return {
    id: "sched-1", managerUserId: "owner-1", sendAt: "2026-09-12T12:00:00Z", status,
    subject: "Update", body: "The rent statement is ready.", recipientEmail: "resident@example.com",
    recipientName: "Resident", recipientUserId: "resident-1", deliverViaInbox: true,
    deliverViaEmail: true, deliverViaSms: false, createdAt: "2026-09-01T12:00:00Z",
  };
}

function fakeDb(recipientEmail = "resident@example.com") {
  const statuses = new Map<string, string>();
  let tokenNumber = 0;
  const rpc = vi.fn(async (name: string, args: Record<string, string>) => {
    if (name === "claim_scheduled_inbox_channel") {
      const status = statuses.get(args.p_channel);
      if (status) return { data: { outcome: status, token: null }, error: null };
      const token = `token-${++tokenNumber}`;
      statuses.set(args.p_channel, "claimed");
      return { data: { outcome: "claimed", token }, error: null };
    }
    if (name === "resolve_scheduled_inbox_channel") {
      statuses.set(args.p_channel, args.p_status);
      return { data: true, error: null };
    }
    if (name === "finalize_scheduled_inbox_delivery") {
      return { data: ["inbox", "email", "sms"].every((channel) =>
        ["submitted", "skipped"].includes(statuses.get(channel) ?? "")), error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return {
    db: {
      rpc,
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn((_column: string, id: string) => ({ maybeSingle: vi.fn(async () => ({
            data: id === "resident-1"
              ? { email: recipientEmail, full_name: "Resident" }
              : { email: "owner@example.com", full_name: "Owner" },
            error: null,
          })) })),
        })),
      })),
    } as never,
    statuses,
    rpc,
  };
}

describe("scheduled inbox channel claims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadScheduledInboxMessageForDelivery).mockResolvedValue(message("sending"));
    vi.mocked(deliverPortalInboxMessage).mockResolvedValue({
      ok: true, recipientCount: 1,
      emailOutcomes: [{ recipientEmail: "resident@example.com", status: "submitted" }],
      smsOutcomes: [],
    });
  });

  it("lets concurrent cron and Send now workers send each channel at most once", async () => {
    const { db } = fakeDb();
    let releaseInbox!: () => void;
    const gate = new Promise<void>((resolve) => { releaseInbox = resolve; });
    vi.mocked(deliverPortalInboxMessage).mockImplementation(async (_db, opts) => {
      if (!opts.suppressInbox) await gate;
      return {
        ok: true, recipientCount: 1,
        emailOutcomes: [{ recipientEmail: "resident@example.com", status: opts.suppressEmail ? "skipped" : "submitted" }],
        smsOutcomes: [],
      };
    });

    const first = sendScheduledInboxMessageNow(db, message());
    await vi.waitFor(() => expect(deliverPortalInboxMessage).toHaveBeenCalledTimes(1));
    const second = await sendScheduledInboxMessageNow(db, message());
    expect(second.ok).toBe(false);
    expect(second.pending).toBe(true);
    releaseInbox();
    const completed = await first;
    expect(completed.ok).toBe(true);
    expect(deliverPortalInboxMessage).toHaveBeenCalledTimes(2); // inbox and email; SMS suppressed
    expect(vi.mocked(deliverPortalInboxMessage).mock.calls.filter(([, opts]) => !opts.suppressInbox)).toHaveLength(1);
  });

  it("holds an uncertain email result and does not send it on replay", async () => {
    const { db, statuses } = fakeDb();
    vi.mocked(deliverPortalInboxMessage).mockImplementation(async (_db, opts) => {
      if (!opts.suppressEmail) throw new Error("provider timeout after request");
      return { ok: true, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] };
    });
    const first = await sendScheduledInboxMessageNow(db, message());
    expect(first).toMatchObject({ ok: false, pending: true });
    expect(statuses.get("email")).toBe("unknown");
    const replay = await sendScheduledInboxMessageNow(db, message("sending"));
    expect(replay).toMatchObject({ ok: false, pending: true });
    expect(vi.mocked(deliverPortalInboxMessage).mock.calls.filter(([, opts]) => !opts.suppressEmail)).toHaveLength(1);
  });

  it("fails before delivery when the stored recipient user ID now points to another email", async () => {
    const { db, statuses } = fakeDb("different@example.com");
    const result = await sendScheduledInboxMessageNow(db, message());
    expect(result).toMatchObject({ ok: false, pending: true });
    expect(statuses.get("inbox")).toBe("failed");
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
  });
});
