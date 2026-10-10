/**
 * Work-number messaging, notices: every PropLane Assistant notice reaches the
 * person in their OWN Assistant thread for the workspace, by text from the
 * workspace's work number (a teammate's billed to the OWNER) and by email from
 * the workspace's work email, each leg gated and idempotent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb } from "../helpers/fake-table-db";

vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: vi.fn(async () => undefined) }));

type Channels = {
  inbox: boolean; email: boolean; sms: boolean; fellBackToAssistant: boolean;
  destination: string; categoryEnabled: boolean;
};
const baseChannels: Channels = {
  inbox: true, email: true, sms: true, fellBackToAssistant: false, destination: "both", categoryEnabled: true,
};
const resolveChannels = vi.fn(async (..._args: unknown[]): Promise<Channels> => ({ ...baseChannels }));
const sendSms = vi.fn(async (_db: unknown, _input: Record<string, unknown>) => ({ sent: true }));
vi.mock("@/lib/manager-notification-routing.server", () => ({
  resolveManagerNotificationChannels: (...args: unknown[]) => resolveChannels(...args),
  sendManagerNotificationSms: (db: unknown, input: Record<string, unknown>) => sendSms(db, input),
}));

const sendEmail = vi.fn(async (_db: unknown, _input: Record<string, unknown>) => ({ status: "sent" as "sent" | "failed" | "skipped" }));
vi.mock("@/lib/manager-notice-email.server", () => ({
  sendManagerNoticeEmail: (db: unknown, input: Record<string, unknown>) => sendEmail(db, input),
}));

const mirror = vi.fn(async (_db: unknown, _input: Record<string, unknown>) => ({ ok: true as const, threadId: "t", appended: true }));
vi.mock("@/lib/sms/manager-assistant-thread-mirror.server", () => ({
  appendSmsTurnToManagerAssistantThread: (db: unknown, input: Record<string, unknown>) => mirror(db, input),
}));

import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";

const OWNER = "owner-1";
const TEAMMATE = "mate-1";
const OTHER_MATE = "mate-2";
const DEFAULT_WS = "ws-default";
const SEATTLE = "ws-seattle";
const HOUSE = "house-5257";
const OTHER_HOUSE = "house-other";

function seed() {
  return createFakeDb({
    portal_workspaces: [
      { id: DEFAULT_WS, owner_user_id: OWNER, is_default: true, name: "Default" },
      { id: SEATTLE, owner_user_id: OWNER, is_default: false, name: "Seattle Homes" },
      { id: "ws-mate-default", owner_user_id: TEAMMATE, is_default: true, name: "Mate" },
    ],
    manager_property_records: [
      { id: HOUSE, workspace_id: SEATTLE },
      { id: OTHER_HOUSE, workspace_id: DEFAULT_WS },
    ],
    portal_inbox_thread_records: [],
    account_link_invites: [
      {
        inviter_user_id: OWNER, invitee_user_id: TEAMMATE, status: "accepted", workspace_id: SEATTLE,
        assigned_property_ids: [HOUSE], property_co_manager_permissions: { [HOUSE]: { payments: true } },
      },
      {
        inviter_user_id: OWNER, invitee_user_id: OTHER_MATE, status: "accepted", workspace_id: SEATTLE,
        assigned_property_ids: [OTHER_HOUSE], property_co_manager_permissions: { [OTHER_HOUSE]: { payments: true } },
      },
    ],
  });
}

const threadIds = (fake: ReturnType<typeof seed>) => fake.tables.portal_inbox_thread_records!.map((row) => row.id);

beforeEach(() => {
  vi.clearAllMocks();
  resolveChannels.mockImplementation(async () => ({ ...baseChannels }));
  sendSms.mockResolvedValue({ sent: true });
  sendEmail.mockResolvedValue({ status: "sent" });
});

describe("notifyManagerFromAgent: the workspace's number and email", () => {
  it("owner: the house's workspace picks the Assistant thread, the work number, and the work email", async () => {
    const fake = seed();
    const result = await notifyManagerFromAgent(fake as unknown as SupabaseClient, {
      landlordId: OWNER, subject: "Rent · Payment update", text: "$1,000.00 was received", propertyId: HOUSE,
      category: "payment_reminders", idempotencyKey: "action-event:k1:manager",
    });
    expect(result).toMatchObject({ delivered: true, sms: "sent", email: "sent" });
    expect(threadIds(fake)).toEqual([`agent_notice_${OWNER}__${SEATTLE}`]);
    // The text leaves from the OWNER's line for that workspace, and says so to the channel resolver too.
    expect(resolveChannels.mock.calls[0]![6]).toEqual({ ownerUserId: OWNER, workspaceId: SEATTLE });
    expect(sendSms.mock.calls[0]![1]).toMatchObject({
      managerUserId: OWNER,
      sendFrom: { ownerUserId: OWNER, workspaceId: SEATTLE },
      dedupeKey: `notice:action-event:k1:manager:${OWNER}`,
      purpose: "manager_agent_notification_payment_reminders",
    });
    expect(sendEmail.mock.calls[0]![1]).toMatchObject({
      recipientUserId: OWNER, ownerUserId: OWNER, workspaceId: SEATTLE,
      idempotencyKey: "action-event:k1:manager",
    });
  });

  it("a house-less notice goes to the owner's default workspace (unsuffixed thread, default line)", async () => {
    const fake = seed();
    await notifyManagerFromAgent(fake as unknown as SupabaseClient, { landlordId: OWNER, subject: "s", text: "t" });
    expect(threadIds(fake)).toEqual([`agent_notice_${OWNER}`]);
    expect(sendSms.mock.calls[0]![1]).toMatchObject({ sendFrom: { ownerUserId: OWNER, workspaceId: DEFAULT_WS } });
  });

  it("teammate: their OWN Assistant thread for the owner's workspace; the text is the OWNER's line, billed to the owner; the email is the owner's work email", async () => {
    const fake = seed();
    await notifyManagerFromAgent(fake as unknown as SupabaseClient, {
      landlordId: TEAMMATE, senderOwnerId: OWNER, subject: "s", text: "t", propertyId: HOUSE,
      idempotencyKey: "k2",
    });
    const [thread] = fake.tables.portal_inbox_thread_records!;
    expect(thread).toMatchObject({ id: `agent_notice_${TEAMMATE}__${SEATTLE}`, owner_user_id: TEAMMATE, thread_type: "agent_notice" });
    expect(resolveChannels.mock.calls[0]![1]).toBe(TEAMMATE); // their own alert preferences
    expect(resolveChannels.mock.calls[0]![6]).toEqual({ ownerUserId: OWNER, workspaceId: SEATTLE });
    expect(sendSms.mock.calls[0]![1]).toMatchObject({
      managerUserId: TEAMMATE, // whose verified phone it is
      sendFrom: { ownerUserId: OWNER, workspaceId: SEATTLE }, // whose line and wallet it uses
      dedupeKey: `notice:k2:${TEAMMATE}`,
    });
    expect(sendEmail.mock.calls[0]![1]).toMatchObject({ recipientUserId: TEAMMATE, ownerUserId: OWNER, workspaceId: SEATTLE });
  });

  it("honors the alert destination and topic: 'none' or a switched-off topic sends no email", async () => {
    resolveChannels.mockImplementation(async () => ({ ...baseChannels, inbox: false, sms: false, destination: "none" }));
    const none = await notifyManagerFromAgent(seed() as unknown as SupabaseClient, { landlordId: OWNER, subject: "s", text: "t" });
    expect(none).toMatchObject({ delivered: false, suppressed: true });
    resolveChannels.mockImplementation(async () => ({ ...baseChannels, categoryEnabled: false }));
    await notifyManagerFromAgent(seed() as unknown as SupabaseClient, { landlordId: OWNER, subject: "s", text: "t" });
    resolveChannels.mockImplementation(async () => ({ ...baseChannels, email: false }));
    await notifyManagerFromAgent(seed() as unknown as SupabaseClient, { landlordId: OWNER, subject: "s", text: "t" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("no sendable number / no verified phone resolves to sms:false: no text, but the Assistant thread and the email still go", async () => {
    resolveChannels.mockImplementation(async () => ({ ...baseChannels, sms: false }));
    const fake = seed();
    const result = await notifyManagerFromAgent(fake as unknown as SupabaseClient, { landlordId: OWNER, subject: "s", text: "t" });
    expect(result).toMatchObject({ delivered: true, sms: "skipped", email: "sent" });
    expect(sendSms).not.toHaveBeenCalled();
    expect(fake.tables.portal_inbox_thread_records).toHaveLength(1);
  });

  it("a refused text (no credit, paused, STOP) never throws while the notice reached them another way", async () => {
    sendSms.mockResolvedValue({ sent: false });
    const result = await notifyManagerFromAgent(seed() as unknown as SupabaseClient, { landlordId: OWNER, subject: "s", text: "t" });
    expect(result).toMatchObject({ delivered: true, sms: "failed" });
    expect(mirror).not.toHaveBeenCalled(); // nothing went out, so no "sent by text" copy
  });

  it("but a notice that reached NOTHING durable still throws so its caller retries", async () => {
    resolveChannels.mockImplementation(async () => ({ ...baseChannels, inbox: false }));
    sendSms.mockResolvedValue({ sent: false });
    sendEmail.mockResolvedValue({ status: "failed" });
    await expect(
      notifyManagerFromAgent(seed() as unknown as SupabaseClient, { landlordId: OWNER, subject: "s", text: "t" }),
    ).rejects.toThrow(/not accepted/);
  });

  it("a retry of the same notice appends one Assistant line", async () => {
    const fake = seed();
    const args = { landlordId: OWNER, subject: "s", text: "t", idempotencyKey: "same" };
    await notifyManagerFromAgent(fake as unknown as SupabaseClient, args);
    await notifyManagerFromAgent(fake as unknown as SupabaseClient, args);
    const row = fake.tables.portal_inbox_thread_records![0]!.row_data as { messages: unknown[] };
    expect(row.messages).toHaveLength(1);
  });
});

describe("notifyPropertyScopedManagersFromAgent: owner + teammates with the house", () => {
  it("reaches the owner and only the teammates granted that module on THAT house, each from the owner's line", async () => {
    const fake = seed();
    await notifyPropertyScopedManagersFromAgent(fake as never, {
      ownerManagerUserId: OWNER, propertyId: HOUSE, module: "payments",
      subject: "s", text: "You approved it", teammateText: "Ambika approved it", idempotencyKey: "k3",
    });
    expect(threadIds(fake).sort()).toEqual([`agent_notice_${OWNER}__${SEATTLE}`, `agent_notice_${TEAMMATE}__${SEATTLE}`].sort());
    const smsTo = sendSms.mock.calls.map(([, input]) => [input.managerUserId, (input.sendFrom as { ownerUserId: string }).ownerUserId]);
    expect(smsTo.sort()).toEqual([[OWNER, OWNER], [TEAMMATE, OWNER]].sort());
    // The teammate is not told "You approved it".
    const mateThread = fake.tables.portal_inbox_thread_records!.find((r) => r.owner_user_id === TEAMMATE)!;
    expect((mateThread.row_data as { messages: Array<{ body: string }> }).messages[0]!.body).toBe("Ambika approved it");
    // Nobody is billed but the owner.
    expect(sendSms.mock.calls.every(([, input]) => (input.sendFrom as { ownerUserId: string }).ownerUserId === OWNER)).toBe(true);
  });

  it("no house means the owner alone; a teammate without access gets nothing", async () => {
    const fake = seed();
    await notifyPropertyScopedManagersFromAgent(fake as never, {
      ownerManagerUserId: OWNER, module: "payments", subject: "s", text: "t", idempotencyKey: "k4",
    });
    expect(threadIds(fake)).toEqual([`agent_notice_${OWNER}`]);
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("excluded people (the actor) are skipped, and a failing teammate never blocks the owner", async () => {
    const fake = seed();
    sendEmail.mockImplementation(async (_db, input) => {
      if (input.recipientUserId === TEAMMATE) throw new Error("boom");
      return { status: "sent" as const };
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await notifyPropertyScopedManagersFromAgent(fake as never, {
      ownerManagerUserId: OWNER, propertyId: HOUSE, module: "payments", subject: "s", text: "t", idempotencyKey: "k5",
    });
    expect(threadIds(fake)).toContain(`agent_notice_${OWNER}__${SEATTLE}`);
    await notifyPropertyScopedManagersFromAgent(fake as never, {
      ownerManagerUserId: OWNER, propertyId: HOUSE, module: "payments", subject: "s", text: "t", idempotencyKey: "k6",
      excludeUserIds: [TEAMMATE],
    });
    expect(sendSms.mock.calls.filter(([, input]) => input.dedupeKey === `notice:k6:${TEAMMATE}`)).toHaveLength(0);
    spy.mockRestore();
  });
});
