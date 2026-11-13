import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb } from "../helpers/fake-table-db";

const enqueueOwnerSms = vi.fn(async (_input: Record<string, unknown>, _db?: unknown) => ({
  ok: true as const, outboxId: "outbox-1", status: "queued", deduplicated: false,
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: (input: Record<string, unknown>, db?: unknown) => enqueueOwnerSms(input, db),
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async () => ({ phoneNumber: "+15005550001", numberId: "line-ws1" }),
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: async () => false }));

import { assertTeamThreadMember, relayTeamChatMessageToSms, resolveWorkspaceTeamMembers } from "@/lib/team-comms.server";
import { conversationVisible, type CommunicationScope } from "@/lib/communication/conversation-visibility.server";

const OWNER = "owner-ambika";
const WS = "ws-ambika";
const verified = "2026-10-01T00:00:00.000Z";

function seed() {
  return createFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: OWNER, is_default: true, name: "1. Ambika", is_service: true }],
    account_link_invites: [
      // a co-manager the client granted herself
      { inviter_user_id: OWNER, invitee_user_id: "co-manager", status: "accepted", workspace_id: WS, team_role: "property_manager" },
      // PropLane staff seats on the service workspace (any manager role)
      { inviter_user_id: OWNER, invitee_user_id: "staff-admin", status: "accepted", workspace_id: WS, team_role: "admin", is_service_seat: true },
      { inviter_user_id: OWNER, invitee_user_id: "staff-bookkeeper", status: "accepted", workspace_id: WS, team_role: "bookkeeper", is_service_seat: true },
      { inviter_user_id: OWNER, invitee_user_id: "staff-viewer", status: "accepted", workspace_id: WS, team_role: "viewer", is_service_seat: true },
      // never members
      { inviter_user_id: OWNER, invitee_user_id: "property-owner", status: "accepted", workspace_id: WS, team_role: "property_owner" },
      { inviter_user_id: OWNER, invitee_user_id: "pending-staff", status: "pending", workspace_id: WS, team_role: "admin", is_service_seat: true },
    ],
    // A resident and a vendor have accounts and phones, but no membership row.
    profiles: ["resident-1", "vendor-1", OWNER, "co-manager", "staff-admin", "staff-bookkeeper", "staff-viewer", "property-owner"].map(
      (id, i) => ({ id, full_name: id, phone: `+1206555${String(1000 + i)}`, phone_verified_at: verified }),
    ),
    sms_outbox: [],
    portal_inbox_thread_records: [],
  });
}

beforeEach(() => enqueueOwnerSms.mockClear());

describe("the one Team chat per workspace: who is in it", () => {
  it("owner + every co-manager/teammate seat (any manager role) + PropLane staff seats; never residents, vendors, property owners or pending", async () => {
    const db = seed() as unknown as SupabaseClient;
    const members = await resolveWorkspaceTeamMembers(db, { ownerManagerUserId: OWNER, workspaceId: WS });
    expect(members[0]).toMatchObject({ userId: OWNER, isOwner: true });
    expect(members.map((m) => m.userId).sort()).toEqual(
      [OWNER, "co-manager", "staff-admin", "staff-bookkeeper", "staff-viewer"].sort(),
    );
    const ids = new Set(members.map((m) => m.userId));
    for (const out of ["resident-1", "vendor-1", "property-owner", "pending-staff"]) expect(ids.has(out)).toBe(false);
  });

  it("the text relay reaches all three groups and nobody else", async () => {
    const db = seed() as unknown as SupabaseClient;
    const outcomes = await relayTeamChatMessageToSms(db, {
      ownerManagerUserId: OWNER,
      workspaceId: WS,
      senderUserId: "co-manager",
      senderName: "Co Manager",
      text: "hello team",
      messageId: "m-1",
    });
    const texted = outcomes.filter((o) => o.status === "sent").map((o) => o.memberUserId).sort();
    expect(texted).toEqual([OWNER, "staff-admin", "staff-bookkeeper", "staff-viewer"].sort());
    const recipients = enqueueOwnerSms.mock.calls.map((call) => call[0].recipientUserId);
    expect(recipients).not.toContain("resident-1");
    expect(recipients).not.toContain("vendor-1");
    expect(recipients).not.toContain("co-manager"); // the sender already knows
  });

  it("read/post access: staff admin posts, staff viewer only reads, residents and vendors never", async () => {
    const db = seed() as unknown as SupabaseClient;
    const can = (userId: string, level: "read" | "edit") =>
      assertTeamThreadMember(db, { ownerManagerUserId: OWNER, workspaceId: WS, userId, level });
    expect(await can("staff-admin", "edit")).toBe(true);
    expect(await can("staff-viewer", "read")).toBe(true);
    expect(await can("staff-viewer", "edit")).toBe(false);
    expect(await can("resident-1", "read")).toBe(false);
    expect(await can("vendor-1", "read")).toBe(false);
  });
});

describe("Team chat visibility in the inbox list", () => {
  const TEAM = `team-thread:${OWNER}:ws:${WS}`;
  const scope = (over: Partial<CommunicationScope>): CommunicationScope => ({
    viewerId: "staff-admin",
    level: "read",
    ownerIds: ["staff-admin"],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: null,
    untaggedOwnedVisible: true,
    activeWorkspaceId: WS,
    workspaceByLine: new Map(),
    ...over,
  });
  const input = { ownerId: OWNER, houseIds: [], threadType: "team", threadId: TEAM };

  it("staff who run the active service workspace see its Team chat even when the membership read found no row", () => {
    expect(conversationVisible(scope({ staffWorkspaceOwners: new Map([[WS, OWNER]]) }), input)).toBe(true);
    expect(conversationVisible(scope({ level: "edit", staffWorkspaceOwners: new Map([[WS, OWNER]]) }), input)).toBe(true);
  });

  it("a stranger (resident, vendor, unrelated manager) never does", () => {
    expect(conversationVisible(scope({ viewerId: "resident-1" }), input)).toBe(false);
    expect(conversationVisible(scope({ staffWorkspaceOwners: new Map([["other-ws", OWNER]]) }), input)).toBe(false);
  });
});
