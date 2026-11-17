/**
 * Round 7 (plan avail-kpis-1117), at the inbox: emits real booking action events against the in-memory Supabase and
 * prints the resulting Team chat rows, so a reviewer can see that a routine booking made/cancelled
 * leaves the Team chat untouched (the owner still gets their Assistant notice) while a clash and a
 * failed sync still post their line. Writes the transcript to `EVIDENCE_DIR`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { createMemoryDb } from "./support/memory-supabase";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";

const notifyManager = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ delivered: true, suppressed: false })));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notifyManager }));
vi.mock("@/lib/work-number-recipients.server", () => ({ notifyWorkNumberRecipients: vi.fn(async () => undefined) }));
const deliverPortalInbox = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ ok: true as const, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] })),
);
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: deliverPortalInbox }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: vi.fn(async () => ({ ok: true as const, outboxId: "outbox-1", status: "queued", deduplicated: false })),
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => ({ phoneNumber: "+15005550001", numberId: "line-ws1" }),
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));

import { emitActionEvent } from "@/lib/action-events.server";

const OWNER = "owner";
const HOUSE = "house-1";
const verified = "2026-10-01T00:00:00.000Z";

function seed() {
  const stamp = stampTeamRolePermissions("property_manager" as never);
  return createMemoryDb({
    portal_workspaces: [{ id: "ws-1", owner_user_id: OWNER, name: "Seattle Homes", is_default: true }],
    manager_property_records: [{ id: HOUSE, manager_user_id: OWNER, workspace_id: "ws-1", row_data: {} }],
    profiles: [
      { id: OWNER, email: "o@x.com", full_name: "Ambika Mago", phone: "+12065550100", phone_verified_at: verified },
      { id: "khue", email: "khue@x.com", full_name: "Khue Mate", phone: "+12065550101", phone_verified_at: verified, sms_forward_inbound: true },
    ],
    account_link_invites: [
      {
        inviter_user_id: OWNER, invitee_user_id: "khue", status: "accepted", workspace_id: "ws-1",
        team_role: "property_manager", house_scope: "selected", assigned_property_ids: [HOUSE],
        co_manager_permissions: stamp, property_co_manager_permissions: { [HOUSE]: stamp },
      },
    ],
    portal_inbox_thread_records: [],
    action_events: [],
    action_event_deliveries: [],
    sms_outbox: [],
  });
}

type Db = ReturnType<typeof seed>;
const teamLines = (db: Db) =>
  db.__tables
    .portal_inbox_thread_records!.filter((r) => r.thread_type === "team")
    .flatMap((r) => ((r.row_data as { messages?: Array<{ id: string; from: string; body: string }> }).messages ?? []));

async function emit(db: Db, event: string, subject: string, text: string) {
  return emitActionEvent(db as unknown as SupabaseClient, {
    eventId: `bk-${event}`,
    domain: "channel_booking",
    event,
    managerUserId: OWNER,
    entityId: `bk-${event}`,
    category: "tours",
    senderUserId: OWNER,
    senderEmail: "o@x.com",
    senderName: "Ambika Mago",
    payload: { propertyId: HOUSE, propertyLabel: "5257 Brooklyn R2", guestLabel: "Alex Kim", stayLabel: "Nov 20–24" },
    recipients: [{ audience: "manager", userId: OWNER, rendered: { subject, text } }],
    now: new Date("2026-11-17T18:00:00.000Z"),
  } as Parameters<typeof emitActionEvent>[1]);
}

beforeEach(() => {
  notifyManager.mockClear();
  deliverPortalInbox.mockClear();
});

describe("routine booking events stay out of the Team chat (evidence)", () => {
  it("made / cancelled post no line; clash and sync-failed still do", async () => {
    const transcript: string[] = [
      "Workspace: Seattle Homes (owner Ambika Mago, teammate Khue Mate)",
      "Every event below is emitted through emitActionEvent against the in-memory Supabase.",
      "",
    ];
    const cases: Array<{ event: string; subject: string; text: string }> = [
      { event: "booking_created", subject: "Booking confirmed", text: "Alex Kim booked 5257 Brooklyn R2 for Nov 20–24." },
      { event: "booking_cancelled", subject: "Booking cancelled", text: "Alex Kim cancelled Nov 20–24 at 5257 Brooklyn R2." },
      { event: "channel_booking_created", subject: "New channel booking", text: "Airbnb booked 5257 Brooklyn R2 for Nov 20–24." },
      { event: "channel_booking_cancelled", subject: "Channel booking cancelled", text: "Airbnb cancelled Nov 20–24." },
      { event: "channel_booking_clash", subject: "Double booking found", text: "Two stays overlap at 5257 Brooklyn R2 on Nov 21." },
      { event: "channel_sync_failed", subject: "Channel calendar not syncing", text: "Airbnb calendar has not synced since Nov 15." },
    ];
    const posted: Record<string, string[]> = {};
    for (const one of cases) {
      const db = seed();
      await emit(db, one.event, one.subject, one.text);
      const lines = teamLines(db).map((m) => m.body);
      posted[one.event] = lines;
      const ownerNotices = notifyManager.mock.calls.map((c) => (c[1] as { landlordId: string }).landlordId);
      transcript.push(
        `${one.event}`,
        `  owner Assistant notice : ${ownerNotices.includes(OWNER) ? `yes — "${one.subject}"` : "no"}`,
        `  Team chat line         : ${lines.length === 0 ? "none" : lines.map((l) => `"${l}"`).join(" | ")}`,
        "",
      );
      notifyManager.mockClear();
    }

    expect(posted.booking_created).toEqual([]);
    expect(posted.booking_cancelled).toEqual([]);
    expect(posted.channel_booking_created).toEqual([]);
    expect(posted.channel_booking_cancelled).toEqual([]);
    expect(posted.channel_booking_clash).toHaveLength(1);
    expect(posted.channel_sync_failed).toHaveLength(1);

    const dir = process.env.EVIDENCE_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/team-chat-routine-bookings.txt`, transcript.join("\n"));
    }
  });
});
