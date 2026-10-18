import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMemoryDb } from "./support/memory-supabase";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";

// A shared-line alert is the existing notice spine pinned to ONE workspace. These tests run the real
// spine (recipients, Team chat line) over two teams and prove nothing crosses.

const notifyManager = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ delivered: true, suppressed: false })));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notifyManager }));
const extraRecipients = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ texted: 0, emailed: 0 })));
vi.mock("@/lib/work-number-recipients.server", () => ({ notifyWorkNumberRecipients: extraRecipients }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: vi.fn(async () => ({ ok: true as const, outboxId: "o", status: "queued", deduplicated: false })),
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => ({ phoneNumber: "+15005550001", numberId: "line" }),
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));

import { alertWorkspaceTeam } from "@/lib/one-number/team-alerts.server";

const verified = "2026-10-01T00:00:00.000Z";

function invite(owner: string, mate: string, workspace: string, house: string) {
  const stamp = stampTeamRolePermissions("property_manager" as never);
  return {
    inviter_user_id: owner, invitee_user_id: mate, status: "accepted", workspace_id: workspace, team_role: "property_manager",
    house_scope: "selected", assigned_property_ids: [house], co_manager_permissions: stamp,
    property_co_manager_permissions: { [house]: stamp },
  };
}

function twoTeams() {
  return createMemoryDb({
    portal_workspaces: [
      { id: "ws-a", owner_user_id: "owner-a", name: "Brooklyn Homes", is_default: true },
      { id: "ws-b", owner_user_id: "owner-b", name: "Eighth Ave Co", is_default: true },
    ],
    manager_property_records: [
      { id: "house-a", manager_user_id: "owner-a", workspace_id: "ws-a", row_data: {} },
      { id: "house-b", manager_user_id: "owner-b", workspace_id: "ws-b", row_data: {} },
    ],
    profiles: [
      { id: "owner-a", email: "oa@x.com", phone: "+12065550101", phone_verified_at: verified },
      { id: "mate-a", email: "ma@x.com", phone: "+12065550102", phone_verified_at: verified, sms_forward_inbound: true },
      { id: "owner-b", email: "ob@x.com", phone: "+12065550201", phone_verified_at: verified },
      { id: "mate-b", email: "mb@x.com", phone: "+12065550202", phone_verified_at: verified, sms_forward_inbound: true },
    ],
    account_link_invites: [invite("owner-a", "mate-a", "ws-a", "house-a"), invite("owner-b", "mate-b", "ws-b", "house-b")],
    portal_inbox_thread_records: [],
    action_events: [],
    action_event_deliveries: [],
    sms_outbox: [],
  });
}
type Db = ReturnType<typeof twoTeams>;
const asDb = (db: Db) => db as unknown as SupabaseClient;
const landlords = () => notifyManager.mock.calls.map((c) => (c[1] as { landlordId: string }).landlordId);
const teamBodies = (db: Db) =>
  db.__tables.portal_inbox_thread_records!
    .filter((r) => r.thread_type === "team")
    .flatMap((r) => ((r.row_data as { messages?: Array<{ body: string }> }).messages ?? []).map((m) => `${String(r.owner_user_id)}:${m.body}`));

beforeEach(() => {
  notifyManager.mockClear();
  extraRecipients.mockClear();
});

describe("alertWorkspaceTeam", () => {
  it("an emergency in team A notices team A only: A's owner and teammate, never B's", async () => {
    const db = twoTeams();
    const result = await alertWorkspaceTeam(asDb(db), {
      workspaceId: "ws-a", ownerUserId: "owner-a", kind: "emergency", urgent: true, propertyId: "house-a",
      text: "Emergency word in a text (5259 Brooklyn)", idempotencyKey: "emergency:SM1:ws-a",
    });
    expect(result).toEqual({ sent: true });
    const who = new Set(landlords());
    expect(who.has("owner-a")).toBe(true);
    expect(who.has("mate-a")).toBe(true);
    expect(who.has("owner-b")).toBe(false);
    expect(who.has("mate-b")).toBe(false);
    // Every notice is stamped with A's workspace and sent for A's owner.
    for (const call of notifyManager.mock.calls) {
      expect(call[1]).toMatchObject({ workspaceId: "ws-a", senderOwnerId: "owner-a" });
    }
    // The "also notify" numbers are A's owner's list.
    expect(extraRecipients.mock.calls.map((c) => (c[1] as { ownerUserId: string; workspaceId: string })).every((i) => i.ownerUserId === "owner-a" && i.workspaceId === "ws-a")).toBe(true);
    expect(extraRecipients).toHaveBeenCalledTimes(1);
  });

  it("with no house named, the alert still lands in the named workspace (not the owner's default) and B stays out", async () => {
    const db = twoTeams();
    // owner-a's DEFAULT workspace is ws-a; give owner-a a second, non-default workspace and alert that one.
    db.__tables.portal_workspaces!.push({ id: "ws-a2", owner_user_id: "owner-a", name: "Second", is_default: false });
    await alertWorkspaceTeam(asDb(db), {
      workspaceId: "ws-a2", ownerUserId: "owner-a", kind: "human_request", urgent: false, text: "Asked for a person", idempotencyKey: "human:SM2:ws-a2",
    });
    expect(landlords()).toEqual(["owner-a"]);
    expect(notifyManager.mock.calls[0][1]).toMatchObject({ workspaceId: "ws-a2" });
    expect(landlords()).not.toContain("owner-b");
    expect(extraRecipients.mock.calls[0][1]).toMatchObject({ ownerUserId: "owner-a", workspaceId: "ws-a2" });
  });

  it("the Team chat line is posted once, in the alerting team's chat only, and is idempotent", async () => {
    const db = twoTeams();
    const input = { workspaceId: "ws-a", ownerUserId: "owner-a", kind: "human_request" as const, urgent: false, propertyId: "house-a", text: "Asked for a person", idempotencyKey: "human:SM3:ws-a" };
    await alertWorkspaceTeam(asDb(db), input);
    await alertWorkspaceTeam(asDb(db), input);
    const lines = teamBodies(db);
    expect(lines).toEqual(["owner-a:Human requested · Asked for a person"]);
    expect(lines.some((l) => l.startsWith("owner-b:"))).toBe(false);
  });

  it("an urgent alert's Team line is marked Emergency", async () => {
    const db = twoTeams();
    await alertWorkspaceTeam(asDb(db), { workspaceId: "ws-a", ownerUserId: "owner-a", kind: "emergency", urgent: true, propertyId: "house-a", text: "Smoke", idempotencyKey: "e:1" });
    expect(teamBodies(db)).toEqual(["owner-a:Emergency · Emergency text · Smoke"]);
  });

  it("a workspace paired with someone else's owner sends nothing at all", async () => {
    const db = twoTeams();
    const result = await alertWorkspaceTeam(asDb(db), {
      workspaceId: "ws-a", ownerUserId: "owner-b", kind: "emergency", urgent: true, text: "Smoke", idempotencyKey: "e:2",
    });
    expect(result).toEqual({ sent: false, reason: "workspace_mismatch" });
    expect(notifyManager).not.toHaveBeenCalled();
    expect(extraRecipients).not.toHaveBeenCalled();
    expect(teamBodies(db)).toEqual([]);
    const missing = await alertWorkspaceTeam(asDb(db), { workspaceId: "ws-nope", ownerUserId: "owner-a", kind: "new_lead", urgent: false, text: "x" });
    expect(missing.sent).toBe(false);
  });

  it("never throws: a failing spine reports not sent", async () => {
    const db = twoTeams();
    notifyManager.mockRejectedValueOnce(new Error("sms provider down"));
    const result = await alertWorkspaceTeam(asDb(db), { workspaceId: "ws-a", ownerUserId: "owner-a", kind: "new_lead", urgent: false, text: "New lead", idempotencyKey: "n:1" });
    expect(result).toEqual({ sent: false, reason: "failed" });
  });

  it("empty text or ids send nothing", async () => {
    const db = twoTeams();
    expect((await alertWorkspaceTeam(asDb(db), { workspaceId: "", ownerUserId: "owner-a", kind: "new_lead", urgent: false, text: "x" })).sent).toBe(false);
    expect((await alertWorkspaceTeam(asDb(db), { workspaceId: "ws-a", ownerUserId: "owner-a", kind: "new_lead", urgent: false, text: "  " })).sent).toBe(false);
    expect(notifyManager).not.toHaveBeenCalled();
  });
});
