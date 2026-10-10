import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type FakeDb } from "../helpers/fake-table-db";

let racingDb: FakeDb | null = null;
const enqueueOwnerSms = vi.fn(async (_input: Record<string, unknown>, _db?: unknown) => {
  // Our row, plus a concurrent fan-out's row landing at the same moment.
  const mine = { id: "outbox-mine", manager_user_id: "owner-1", purpose: "team_chat_relay", selected_work_line_id: "line-ws1", status: "queued", created_at: new Date().toISOString() };
  racingDb?.tables.sms_outbox!.push(mine, { ...mine, id: "outbox-racer" });
  return { ok: true as const, outboxId: "outbox-mine", status: "queued", deduplicated: false };
});
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: (input: Record<string, unknown>, db?: unknown) => enqueueOwnerSms(input, db),
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => ({ phoneNumber: "+15005550001", numberId: "line-ws1" }),
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));
const defaultWorkspace = vi.hoisted(() => ({ id: "ws-1" }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/manager-assistant-workspace.server")>()),
  userDefaultWorkspaceId: async () => defaultWorkspace.id,
}));

import { relayTeamChatMessageToSms, resolveWorkspaceTeamMembers } from "@/lib/team-comms.server";

const OWNER = "owner-1";
const verified = "2026-10-01T00:00:00.000Z";

function seed() {
  return createFakeDb({
    portal_workspaces: [{ id: "ws-1", owner_user_id: OWNER, is_default: true, name: "Seattle" }],
    account_link_invites: [
      { inviter_user_id: OWNER, invitee_user_id: "tm-default", status: "accepted", workspace_id: null, team_role: "admin" },
      { inviter_user_id: OWNER, invitee_user_id: "tm-elsewhere", status: "accepted", workspace_id: "ws-2", team_role: "admin" },
    ],
    profiles: [
      { id: OWNER, phone: "+12065550100", phone_verified_at: verified },
      { id: "tm-default", phone: "+12065550101", phone_verified_at: verified },
    ],
    sms_outbox: [],
  });
}

beforeEach(() => {
  defaultWorkspace.id = "ws-1";
  racingDb = null;
  enqueueOwnerSms.mockClear();
});

describe("resolveWorkspaceTeamMembers with no resolvable workspace", () => {
  it("returns the owner alone when there is no default workspace and none was asked for", async () => {
    defaultWorkspace.id = "";
    const members = await resolveWorkspaceTeamMembers(seed() as unknown as SupabaseClient, { ownerManagerUserId: OWNER });
    expect(members.map((member) => member.userId)).toEqual([OWNER]);
  });

  it("still lists the default workspace's teammates when it resolves", async () => {
    const members = await resolveWorkspaceTeamMembers(seed() as unknown as SupabaseClient, { ownerManagerUserId: OWNER });
    expect(members.map((member) => member.userId).sort()).toEqual([OWNER, "tm-default"].sort());
  });
});

describe("team relay hourly cap under a concurrent fan-out", () => {
  it("blocks a text that, once inserted, pushed the workspace over its cap", async () => {
    const db = seed();
    racingDb = db;
    const outcomes = await relayTeamChatMessageToSms(db as unknown as SupabaseClient, {
      ownerManagerUserId: OWNER,
      workspaceId: "ws-1",
      senderUserId: "tm-default",
      senderName: "Tee",
      text: "hello",
      messageId: "m1",
      cap: 1,
    });
    expect(outcomes).toEqual([{ memberUserId: OWNER, status: "skipped", reason: "hourly_cap" }]);
    expect(db.tables.sms_outbox!.find((row) => row.id === "outbox-mine")).toMatchObject({ status: "blocked", blocked_reason: "hourly_cap" });
  });
});
