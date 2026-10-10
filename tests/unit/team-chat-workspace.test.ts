import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb } from "../helpers/fake-table-db";

const enqueueOwnerSms = vi.fn(async (_input: Record<string, unknown>, _db?: unknown) => ({
  ok: true as const, outboxId: "outbox-1", status: "queued", deduplicated: false,
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: (input: Record<string, unknown>, db?: unknown) => enqueueOwnerSms(input, db),
}));

const resolveWorkspaceSendLine = vi.fn(async (..._args: unknown[]): Promise<{ phoneNumber: string; numberId: string | null } | null> => ({
  phoneNumber: "+15005550001", numberId: "line-ws1",
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: (...args: unknown[]) => resolveWorkspaceSendLine(...args),
}));

const stopped = new Set<string>();
vi.mock("@/lib/sms-consent", () => ({
  isPhoneOptedOut: async (_db: unknown, phone: string) => stopped.has(phone),
}));

import {
  assertTeamThreadMember,
  ensureWorkspaceTeamThread,
  isTeamThreadId,
  parseTeamThreadId,
  postTeamThreadMessage,
  relayTeamChatMessageToSms,
  resolveTeamNoticeRecipientIds,
  resolveWorkspaceTeamMembers,
  teamThreadId,
  updateTeamThreadMailboxState,
  workspaceTeamThreadId,
} from "@/lib/team-comms.server";

const OWNER = "owner-1";
const WS = "ws-seattle";
const OTHER_WS = "ws-portland";
const verified = "2026-10-01T00:00:00.000Z";

function seed() {
  return createFakeDb({
    portal_workspaces: [
      { id: WS, owner_user_id: OWNER, is_default: true, name: "Seattle Homes" },
      { id: OTHER_WS, owner_user_id: OWNER, is_default: false, name: "Portland" },
    ],
    account_link_invites: [
      { inviter_user_id: OWNER, invitee_user_id: "prakrit", status: "accepted", workspace_id: WS, team_role: "admin" },
      { inviter_user_id: OWNER, invitee_user_id: "akshaya", status: "accepted", workspace_id: null, team_role: "property_manager" },
      { inviter_user_id: OWNER, invitee_user_id: "viewer", status: "accepted", workspace_id: WS, team_role: "viewer" },
      { inviter_user_id: OWNER, invitee_user_id: "elsewhere", status: "accepted", workspace_id: OTHER_WS, team_role: "admin" },
      { inviter_user_id: OWNER, invitee_user_id: "investor", status: "accepted", workspace_id: WS, team_role: "property_owner" },
      { inviter_user_id: OWNER, invitee_user_id: "pending", status: "pending", workspace_id: WS, team_role: "admin" },
    ],
    profiles: [
      { id: OWNER, full_name: "Ambika Mago", phone: "+12065550100", phone_verified_at: verified },
      { id: "prakrit", full_name: "Prakrit Ramachandran", phone: "+12065550101", phone_verified_at: verified },
      { id: "akshaya", full_name: "Akshaya K", phone: "+12065550102", phone_verified_at: verified },
      { id: "viewer", full_name: "Vee", phone: "+12065550103", phone_verified_at: verified },
    ],
    portal_inbox_thread_records: [],
    sms_outbox: [],
  });
}

beforeEach(() => {
  enqueueOwnerSms.mockClear();
  enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "queued", deduplicated: false });
  resolveWorkspaceSendLine.mockClear();
  resolveWorkspaceSendLine.mockResolvedValue({ phoneNumber: "+15005550001", numberId: "line-ws1" });
  stopped.clear();
});

describe("workspace Team chat ids", () => {
  it("one id per owner and workspace, and legacy ids still parse", () => {
    expect(workspaceTeamThreadId(OWNER, WS)).toBe(`team-thread:${OWNER}:ws:${WS}`);
    expect(isTeamThreadId(workspaceTeamThreadId(OWNER, WS))).toBe(true);
    expect(parseTeamThreadId(`team-thread:${OWNER}:ws:${WS}`)).toEqual({ ownerManagerUserId: OWNER, workspaceId: WS, propertyId: null });
    // Legacy: per house, and the house-less owner thread.
    expect(parseTeamThreadId("team-thread:owner-1:prop-1")).toEqual({ ownerManagerUserId: "owner-1", workspaceId: null, propertyId: "prop-1" });
    expect(parseTeamThreadId("team-thread:owner-1")).toEqual({ ownerManagerUserId: "owner-1", workspaceId: null, propertyId: null });
    expect(teamThreadId("owner-1", "prop-1")).toBe("team-thread:owner-1:prop-1");
    expect(parseTeamThreadId("agent_notice_owner-1")).toBeNull();
    expect(parseTeamThreadId("team-thread:owner-1:ws:")).toBeNull();
  });
});

describe("workspace Team chat membership", () => {
  it("is the owner plus accepted teammates of THIS workspace, regardless of house, never a property owner or a pending invite", async () => {
    const { db } = { db: seed() as unknown as SupabaseClient };
    const members = await resolveWorkspaceTeamMembers(db, { ownerManagerUserId: OWNER, workspaceId: WS });
    // A row with no workspace is the owner's default workspace's.
    expect(members.map((m) => m.userId).sort()).toEqual(["akshaya", OWNER, "prakrit", "viewer"].sort());
    expect(members[0]).toMatchObject({ userId: OWNER, isOwner: true });
    const portland = await resolveWorkspaceTeamMembers(db, { ownerManagerUserId: OWNER, workspaceId: OTHER_WS });
    expect(portland.map((m) => m.userId).sort()).toEqual(["elsewhere", OWNER]);
    expect((await resolveTeamNoticeRecipientIds(db, { ownerManagerUserId: OWNER, workspaceId: OTHER_WS })).sort()).toEqual(["elsewhere", OWNER]);
  });

  it("assertTeamThreadMember: owner always; members of that workspace; a Viewer reads but never posts; other workspaces and strangers never", async () => {
    const db = seed() as unknown as SupabaseClient;
    const on = (userId: string, level: "read" | "edit", workspaceId = WS) =>
      assertTeamThreadMember(db, { ownerManagerUserId: OWNER, workspaceId, userId, level });
    expect(await on(OWNER, "edit")).toBe(true);
    expect(await on("prakrit", "edit")).toBe(true);
    expect(await on("akshaya", "edit")).toBe(true);
    expect(await on("viewer", "read")).toBe(true);
    expect(await on("viewer", "edit")).toBe(false);
    expect(await on("elsewhere", "read")).toBe(false);
    expect(await on("elsewhere", "read", OTHER_WS)).toBe(true);
    expect(await on("investor", "read")).toBe(false);
    expect(await on("pending", "read")).toBe(false);
    expect(await on("stranger", "read")).toBe(false);
  });
});

describe("postTeamThreadMessage", () => {
  const post = (db: SupabaseClient, over: Record<string, unknown> = {}) =>
    postTeamThreadMessage(db, {
      ownerManagerUserId: OWNER,
      workspaceId: WS,
      actorUserId: "prakrit",
      actorName: "Prakrit Ramachandran",
      text: "I'll meet the plumber at 5257",
      messageId: "m1",
      channel: "app",
      ...over,
    } as Parameters<typeof postTeamThreadMessage>[1]);

  it("creates the one workspace chat named Team · <workspace>, with a neutral first line and the poster's name, actor and channel on the message", async () => {
    const fake = seed();
    const db = fake as unknown as SupabaseClient;
    const result = await post(db);
    expect(result).toMatchObject({ ok: true, posted: true, threadId: `team-thread:${OWNER}:ws:${WS}`, workspaceId: WS });
    const rows = fake.tables.portal_inbox_thread_records!;
    expect(rows).toHaveLength(1);
    const row = rows[0]!.row_data as Record<string, unknown>;
    expect(rows[0]).toMatchObject({ id: `team-thread:${OWNER}:ws:${WS}`, thread_type: "team", owner_user_id: OWNER });
    expect(row.from).toBe("Team · Seattle Homes");
    expect(row.subject).toBe("Team · Seattle Homes");
    expect(row.workspaceId).toBe(WS);
    // The thread's own first turn is a system line, never the first poster.
    expect(String(row.body)).toMatch(/team chat/i);
    expect(row.messages).toEqual([
      expect.objectContaining({ id: "m1", from: "Prakrit Ramachandran", actorUserId: "prakrit", channel: "proplane", body: "I'll meet the plumber at 5257" }),
    ]);
  });

  it("a second poster, an sms line and a replayed message id all land in the SAME chat; a replay appends nothing", async () => {
    const fake = seed();
    const db = fake as unknown as SupabaseClient;
    await post(db);
    await post(db, { messageId: "m2", actorUserId: "akshaya", actorName: "Akshaya K", text: "thumbs up", channel: "sms" });
    const replay = await post(db, { messageId: "m2", actorUserId: "akshaya", actorName: "Akshaya K", text: "thumbs up", channel: "sms" });
    expect(replay).toMatchObject({ ok: true, posted: false });
    const rows = fake.tables.portal_inbox_thread_records!;
    expect(rows).toHaveLength(1);
    const messages = (rows[0]!.row_data as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages.map((m) => [m.id, m.from, m.channel])).toEqual([
      ["m1", "Prakrit Ramachandran", "proplane"],
      ["m2", "Akshaya K", "sms"],
    ]);
  });

  it("with no workspace named, the owner's default workspace's chat", async () => {
    const fake = seed();
    const result = await post(fake as unknown as SupabaseClient, { workspaceId: undefined });
    expect(result).toMatchObject({ ok: true, threadId: `team-thread:${OWNER}:ws:${WS}` });
  });

  it("a LEGACY house thread is answered in place, not moved", async () => {
    const fake = seed();
    const result = await post(fake as unknown as SupabaseClient, { workspaceId: null, propertyId: "prop-1" });
    expect(result).toMatchObject({ ok: true, threadId: `team-thread:${OWNER}:prop-1`, workspaceId: null });
  });
});

describe("relayTeamChatMessageToSms", () => {
  const relay = (db: SupabaseClient, over: Record<string, unknown> = {}) =>
    relayTeamChatMessageToSms(db, {
      ownerManagerUserId: OWNER,
      workspaceId: WS,
      senderUserId: "prakrit",
      senderName: "Prakrit Ramachandran",
      text: "I'll meet the plumber at 5257",
      messageId: "m1",
      ...over,
    } as Parameters<typeof relayTeamChatMessageToSms>[1]);

  it("texts every OTHER member from the workspace line, billed to the owner, 'FirstName: text', deduped per (message, member), never back to the sender", async () => {
    const db = seed() as unknown as SupabaseClient;
    const outcomes = await relay(db);
    expect(outcomes.filter((o) => o.status === "sent").map((o) => o.memberUserId).sort()).toEqual([OWNER, "akshaya", "viewer"].sort());
    expect(outcomes.some((o) => o.memberUserId === "prakrit")).toBe(false);
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(3);
    for (const [input] of enqueueOwnerSms.mock.calls) {
      expect(input).toMatchObject({
        managerUserId: OWNER, // billed to the owner, whoever is texted
        actorUserId: "prakrit",
        selectedWorkLineId: "line-ws1",
        sendClass: "transactional",
        purpose: "team_chat_relay",
        body: "Prakrit: I'll meet the plumber at 5257",
      });
      expect(input.recipientUserId).not.toBe("prakrit");
      expect(String(input.dedupeKey)).toBe(`team-chat:m1:${String(input.recipientUserId)}`);
    }
    expect(resolveWorkspaceSendLine).toHaveBeenCalledWith(expect.anything(), OWNER, WS);
  });

  it("the owner typing sends to the teammates and not to herself", async () => {
    const db = seed() as unknown as SupabaseClient;
    await relay(db, { senderUserId: OWNER, senderName: "Ambika Mago" });
    const to = enqueueOwnerSms.mock.calls.map(([input]) => input.recipientUserId).sort();
    expect(to).toEqual(["akshaya", "prakrit", "viewer"]);
    expect(enqueueOwnerSms.mock.calls[0]![0]!.body).toMatch(/^Ambika: /);
  });

  it("a member with no verified phone, a STOP, or inbound forwarding off gets no text; the rest still do", async () => {
    const fake = seed();
    const profiles = fake.tables.profiles!;
    profiles.find((p) => p.id === "akshaya")!.phone_verified_at = null; // unverified
    profiles.find((p) => p.id === "viewer")!.sms_forward_inbound = false; // forwarding off
    stopped.add("+12065550100"); // the owner replied STOP
    const outcomes = await relay(fake as unknown as SupabaseClient);
    expect(Object.fromEntries(outcomes.map((o) => [o.memberUserId, o.reason ?? o.status]))).toEqual({
      [OWNER]: "stop",
      akshaya: "phone_unverified",
      viewer: "member_opted_out_of_texts",
    });
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("no sendable work number means no texts at all (the chat itself is untouched)", async () => {
    resolveWorkspaceSendLine.mockResolvedValueOnce(null);
    expect(await relay(seed() as unknown as SupabaseClient)).toEqual([]);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("a refused enqueue (no credit, paused) is a failed outcome, never a throw", async () => {
    enqueueOwnerSms.mockResolvedValue({ ok: false, error: "comms_billing_insufficient_credit" } as never);
    const outcomes = await relay(seed() as unknown as SupabaseClient);
    expect(outcomes.every((o) => o.status === "failed")).toBe(true);
  });

  it("caps relayed texts per workspace per hour: over the cap the texts are skipped", async () => {
    const fake = seed();
    const now = new Date("2026-10-09T12:00:00.000Z");
    for (let i = 0; i < 59; i += 1) {
      fake.tables.sms_outbox!.push({
        id: `o${i}`, manager_user_id: OWNER, purpose: "team_chat_relay", selected_work_line_id: "line-ws1",
        created_at: "2026-10-09T11:30:00.000Z",
      });
    }
    // Another workspace's relays and old ones do not count.
    fake.tables.sms_outbox!.push({ id: "x1", manager_user_id: OWNER, purpose: "team_chat_relay", selected_work_line_id: "line-other", created_at: "2026-10-09T11:30:00.000Z" });
    fake.tables.sms_outbox!.push({ id: "x2", manager_user_id: OWNER, purpose: "team_chat_relay", selected_work_line_id: "line-ws1", created_at: "2026-10-09T09:00:00.000Z" });
    const outcomes = await relay(fake as unknown as SupabaseClient, { now });
    // One slot left of 60: exactly one text goes, the rest wait.
    expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o.reason === "hourly_cap")).toHaveLength(2);
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(1);
  });

  it("an unreadable count fails closed (no texts), not open", async () => {
    const fake = seed();
    const original = fake.from.bind(fake);
    (fake as { from: unknown }).from = (table: string) => {
      if (table === "sms_outbox") throw new Error("down");
      return original(table);
    };
    const outcomes = await relay(fake as unknown as SupabaseClient);
    expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(0);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });
});

describe("updateTeamThreadMailboxState", () => {
  const draft = (text: string, generatedAt: string) => ({ text, status: "pending_approval", generatedAt, requiresReview: true });
  const threadId = `team-thread:${OWNER}:ws:${WS}`;
  const post = (db: SupabaseClient, messageId: string, actorName: string, text: string) =>
    postTeamThreadMessage(db, { ownerManagerUserId: OWNER, workspaceId: WS, actorUserId: "prakrit", actorName, text, messageId, channel: "app" });

  it("merges only folder / unread / resolved drafts: the lines others appended survive a stale client snapshot", async () => {
    const fake = seed();
    const db = fake as unknown as SupabaseClient;
    await post(db, "m0", "Jamie", "root line");
    await post(db, "m1", "Sam", "from Sam");
    await updateTeamThreadMailboxState(db, { id: threadId }, {
      id: threadId, unread: false, folder: "trash", messages: [], body: "clobbered", email: "viewer@example.com",
    });
    const row = fake.tables.portal_inbox_thread_records![0]!;
    const rowData = row.row_data as Record<string, unknown>;
    expect(rowData.unread).toBe(false);
    expect(rowData.folder).toBe("trash");
    expect(rowData.previousFolder).toBe("inbox");
    expect(rowData.email).toBe("");
    expect(String(rowData.body)).toMatch(/team chat/i);
    expect((rowData.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["m0", "m1"]);
    expect(row.participant_email).toBeNull();
  });

  it("a new line pulls a trashed chat back into the inbox for everyone", async () => {
    const fake = seed();
    const db = fake as unknown as SupabaseClient;
    await post(db, "m0", "Jamie", "hi");
    await updateTeamThreadMailboxState(db, { id: threadId }, { id: threadId, folder: "trash" });
    await post(db, "m1", "Sam", "back");
    expect((fake.tables.portal_inbox_thread_records![0]!.row_data as { folder: string }).folder).toBe("inbox");
  });

  it("keeps a legacy pending review draft the viewer never saw, and removes exactly the ones they resolved", async () => {
    const fake = seed();
    const db = fake as unknown as SupabaseClient;
    await post(db, "m0", "Jamie", "hi");
    const rowData = fake.tables.portal_inbox_thread_records![0]!.row_data as Record<string, unknown>;
    rowData.aiDraft = draft("first", "g1");
    rowData.aiDraftQueue = [draft("second", "g2"), draft("third", "g3")];
    await updateTeamThreadMailboxState(db, { id: threadId }, { id: threadId, folder: "trash" });
    expect(((fake.tables.portal_inbox_thread_records![0]!.row_data as Record<string, unknown>).aiDraft as { text: string }).text).toBe("first");
    await updateTeamThreadMailboxState(db, { id: threadId }, { id: threadId, resolvedAiDraftIds: ["g1", "g3"] });
    const after = fake.tables.portal_inbox_thread_records![0]!.row_data as Record<string, unknown>;
    expect((after.aiDraft as { text: string }).text).toBe("second");
    expect(after.aiDraftQueue).toBeUndefined();
  });
});

describe("ensureWorkspaceTeamThread", () => {
  it("creates the chat once a workspace has two people, named Team · <workspace>, with no messages; a second call changes nothing", async () => {
    const fake = seed();
    const db = fake as unknown as SupabaseClient;
    expect(await ensureWorkspaceTeamThread(db, { ownerManagerUserId: OWNER, workspaceId: WS })).toBe(`team-thread:${OWNER}:ws:${WS}`);
    const rows = fake.tables.portal_inbox_thread_records!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ thread_type: "team", owner_user_id: OWNER });
    expect(rows[0]!.row_data).toMatchObject({ from: "Team · Seattle Homes", messages: [], workspaceId: WS, unread: false });
    await ensureWorkspaceTeamThread(db, { ownerManagerUserId: OWNER, workspaceId: WS });
    expect(rows).toHaveLength(1);
  });

  it("a solo workspace gets no chat (everything it texts goes to the Assistant)", async () => {
    const fake = seed();
    fake.tables.account_link_invites = [];
    expect(await ensureWorkspaceTeamThread(fake as unknown as SupabaseClient, { ownerManagerUserId: OWNER, workspaceId: WS })).toBeNull();
    expect(fake.tables.portal_inbox_thread_records).toHaveLength(0);
  });
});
