import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMemoryDb } from "./support/memory-supabase";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";

// Routine notices to the team are ONE PropLane line in the Team chat; a
// teammate's Assistant gets a notice only when the event is urgent; the owner
// always gets theirs; never a per-teammate conversation.

const notifyManager = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ delivered: true, suppressed: false })));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notifyManager }));
vi.mock("@/lib/work-number-recipients.server", () => ({ notifyWorkNumberRecipients: vi.fn(async () => undefined) }));

const deliverPortalInbox = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ ok: true as const, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] })),
);
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: deliverPortalInbox }));

const enqueueOwnerSms = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>, _db?: unknown) => ({
    ok: true as const, outboxId: "outbox-1", status: "queued", deduplicated: false,
  })),
);
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: (input: Record<string, unknown>, db?: unknown) => enqueueOwnerSms(input, db),
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => ({ phoneNumber: "+15005550001", numberId: "line-ws1" }),
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));

import { emitActionEvent } from "@/lib/action-events.server";
import { notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";
import { buildTeamNoticeLine } from "@/lib/team-notice-line";

const OWNER = "owner";
const HOUSE = "house-1";
const verified = "2026-10-01T00:00:00.000Z";

function invite(userId: string, role: string) {
  const stamp = stampTeamRolePermissions(role as never);
  return {
    inviter_user_id: OWNER, invitee_user_id: userId, status: "accepted", workspace_id: "ws-1", team_role: role,
    house_scope: "selected", assigned_property_ids: [HOUSE], co_manager_permissions: stamp,
    property_co_manager_permissions: { [HOUSE]: stamp },
  };
}

function seed(opts: { teammates?: string[]; mateTexting?: boolean } = {}) {
  const mates = opts.teammates ?? ["khue", "jaarav"];
  return createMemoryDb({
    portal_workspaces: [{ id: "ws-1", owner_user_id: OWNER, name: "Seattle Homes", is_default: true }],
    manager_property_records: [{ id: HOUSE, manager_user_id: OWNER, workspace_id: "ws-1", row_data: {} }],
    profiles: [
      { id: OWNER, email: "o@x.com", full_name: "Ambika Mago", phone: "+12065550100", phone_verified_at: verified },
      ...mates.map((id, i) => ({
        id, email: `${id}@x.com`, full_name: `${id} Mate`, phone: `+1206555010${i + 1}`, phone_verified_at: verified,
        sms_forward_inbound: id === "jaarav" ? opts.mateTexting === true : true,
      })),
    ],
    account_link_invites: mates.map((id) => invite(id, "property_manager")),
    portal_inbox_thread_records: [],
    action_events: [],
    action_event_deliveries: [],
    sms_outbox: [],
  });
}

type Db = ReturnType<typeof seed>;
const asDb = (db: Db) => db as unknown as SupabaseClient;

const teamThreads = (db: Db) => db.__tables.portal_inbox_thread_records!.filter((r) => r.thread_type === "team");
const teamLines = (db: Db) =>
  teamThreads(db).flatMap((r) => ((r.row_data as { messages?: Array<{ id: string; from: string; body: string }> }).messages ?? []));
const landlords = () => notifyManager.mock.calls.map((c) => (c[1] as { landlordId: string }).landlordId).sort();

function workOrderEvent(db: Db, over: Record<string, unknown> = {}) {
  const teammates = ["khue", "jaarav"];
  return emitActionEvent(asDb(db), {
    eventId: "wo-1:created",
    domain: "work_order",
    event: "created",
    managerUserId: OWNER,
    entityId: "wo-1",
    category: "maintenance",
    senderUserId: "resident-1",
    senderEmail: "res@x.com",
    senderName: "Khue",
    payload: { title: "Access or lock issue", propertyId: HOUSE, propertyLabel: "5257 Brooklyn R2", emergency: false },
    recipients: [
      { audience: "manager", userId: OWNER, rendered: { subject: "Service · Access", text: "New service request: Access or lock issue." } },
      ...teammates.map((id) => ({
        audience: "manager" as const, userId: id, rendered: { subject: "Service · Access", text: "New service request: Access or lock issue." },
      })),
    ],
    now: new Date("2026-10-13T16:46:00.000Z"),
    ...over,
  } as Parameters<typeof emitActionEvent>[1]);
}

beforeEach(() => {
  notifyManager.mockClear();
  deliverPortalInbox.mockClear();
  enqueueOwnerSms.mockClear();
});

describe("buildTeamNoticeLine", () => {
  it("is a plain fact line, says service request for a work order, and prefixes Emergency", () => {
    const line = buildTeamNoticeLine({ domain: "work_order", event: "created", subject: "Access or lock issue", place: "5257 Brooklyn R2", who: "Khue" });
    expect(line).toBe("Service request · Access or lock issue · 5257 Brooklyn R2 · filed by Khue · open");
    expect(line).not.toMatch(/work order/i);
    expect(buildTeamNoticeLine({ domain: "work_order", event: "created", subject: "x", urgent: true })).toBe("Emergency · Service request · x · open");
  });
});

describe("routine event in a 3-person workspace", () => {
  it("resident-filed: one PropLane line, no teammate threads, and the owner keeps their normal message", async () => {
    const db = seed();
    const result = await workOrderEvent(db);
    expect(result.failed).toBe(0);
    expect(result.delivered).toBe(3);
    expect(teamLines(db)).toHaveLength(1);
    expect(teamLines(db)[0]).toMatchObject({
      id: "action-event:wo-1:created:team",
      from: "PropLane",
      body: "Service request · Access or lock issue · 5257 Brooklyn R2 · filed by Khue · open",
    });
    // Only the owner's own copy goes through the person-to-person path; no teammate does, and no teammate Assistant is noticed.
    expect(deliverPortalInbox.mock.calls.map((c) => (c[1] as { toUserIds?: string[] }).toUserIds)).toEqual([[OWNER]]);
    expect(landlords()).toEqual([]);
    // Nothing but the Team chat was created in the inbox: no conversation titled with a teammate.
    expect(db.__tables.portal_inbox_thread_records).toHaveLength(1);
  });

  it("the owner as the sender (manager-filed): the owner's Assistant notice plus one line, no owner-visible teammate thread", async () => {
    const db = seed();
    await workOrderEvent(db, { eventId: "wo-2:created", senderUserId: OWNER, senderEmail: "o@x.com", senderName: "Ambika Mago" });
    expect(deliverPortalInbox).not.toHaveBeenCalled();
    expect(db.__tables.portal_inbox_thread_records!.filter((r) => r.thread_type !== "team")).toHaveLength(0);
    expect(teamLines(db)).toHaveLength(1);
    expect(landlords()).toEqual([OWNER]);
  });

  it("the same event twice (a retry) is still one line", async () => {
    const db = seed();
    await workOrderEvent(db);
    await workOrderEvent(db);
    expect(teamLines(db)).toHaveLength(1);
    const cosmetic = db.__tables.portal_inbox_thread_records!.filter((r) => r.thread_type === "team");
    expect(cosmetic).toHaveLength(1);
  });
});

describe("urgent event", () => {
  it("keeps the per-person notices and per-person recipients, plus the same Team line marked Emergency", async () => {
    const db = seed();
    await workOrderEvent(db, {
      eventId: "wo-3:created",
      urgent: true,
      payload: { title: "Access or lock issue", propertyId: HOUSE, propertyLabel: "5257 Brooklyn R2", emergency: true },
    });
    // Resident-filed: the owner's normal message, plus each teammate's own Assistant notice and per-person message, as today.
    expect(landlords()).toEqual(["jaarav", "khue"]);
    expect(deliverPortalInbox.mock.calls.map((c) => (c[1] as { toUserIds?: string[] }).toUserIds?.[0]).sort()).toEqual(["jaarav", "khue", OWNER]);
    expect(teamLines(db)).toHaveLength(1);
    expect(teamLines(db)[0]!.body).toBe("Emergency · Service request · Access or lock issue · 5257 Brooklyn R2 · filed by Khue · open");
  });
});

describe("a routine event with no teamNotice from the caller", () => {
  it("tour booked: one derived Team line (first line, 160 chars, event label), the owner's notice, zero teammate Assistant notices", async () => {
    const db = seed();
    const long = `Jo booked a tour of 5257 Brooklyn R2 for Saturday. ${"x".repeat(200)}\nSecond line is dropped.`;
    await notifyPropertyScopedManagersFromAgent(asDb(db) as never, {
      ownerManagerUserId: OWNER, propertyId: HOUSE, module: "calendar", subject: "Tour booked", text: long,
      idempotencyKey: "action-event:tour-1:booked:team",
    });
    expect(landlords()).toEqual([OWNER]);
    expect(teamLines(db)).toHaveLength(1);
    const body = teamLines(db)[0]!.body;
    expect(body.startsWith("Tour · Jo booked a tour of 5257 Brooklyn R2 for Saturday.")).toBe(true);
    expect(body).not.toContain("Second line");
    expect(body.length).toBe("Tour · ".length + 160);
    expect(teamLines(db)[0]).toMatchObject({ id: "action-event:tour-1:booked:team:team", from: "PropLane" });
    // A retry is still one line.
    await notifyPropertyScopedManagersFromAgent(asDb(db) as never, {
      ownerManagerUserId: OWNER, propertyId: HOUSE, module: "calendar", subject: "Tour booked", text: long,
      idempotencyKey: "action-event:tour-1:booked:team",
    });
    expect(teamLines(db)).toHaveLength(1);
  });
});

describe("one-person workspace", () => {
  it("gives the owner the notice and creates no Team thread", async () => {
    const db = seed({ teammates: [] });
    await notifyPropertyScopedManagersFromAgent(asDb(db) as never, {
      ownerManagerUserId: OWNER, propertyId: HOUSE, module: "services", subject: "s", text: "t",
      idempotencyKey: "k", teamNotice: { text: "Service request · x · open", messageId: "action-event:k:team" },
    });
    expect(landlords()).toEqual([OWNER]);
    expect(teamThreads(db)).toHaveLength(0);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });
});

describe("text relay of the Team line", () => {
  it("follows each teammate's existing team-texting setting and never texts the owner or the actor", async () => {
    const db = seed({ mateTexting: false });
    await notifyPropertyScopedManagersFromAgent(asDb(db) as never, {
      ownerManagerUserId: OWNER, propertyId: HOUSE, module: "services", subject: "s", text: "t",
      idempotencyKey: "k", excludeUserIds: ["khue"],
      teamNotice: { text: "Service request · x · open", messageId: "action-event:k:team" },
    });
    // khue is the actor (excluded), jaarav switched team texting off, the owner already has the Assistant text.
    expect(enqueueOwnerSms).not.toHaveBeenCalled();

    const on = seed({ mateTexting: true });
    await notifyPropertyScopedManagersFromAgent(asDb(on) as never, {
      ownerManagerUserId: OWNER, propertyId: HOUSE, module: "services", subject: "s", text: "t",
      idempotencyKey: "k", teamNotice: { text: "Service request · x · open", messageId: "action-event:k:team" },
    });
    const to = enqueueOwnerSms.mock.calls.map(([input]) => input.recipientUserId).sort();
    expect(to).toEqual(["jaarav", "khue"]);
    expect(enqueueOwnerSms.mock.calls[0]![0]!.body).toBe("PropLane: Service request · x · open");
  });
});
