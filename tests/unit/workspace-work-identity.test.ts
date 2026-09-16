/**
 * A work number and a work email belong to a WORKSPACE — a portal_workspaces
 * row — not to a user and not to "owner + co-manager links".
 *
 * The bug this pins (Sep 15 2026): Prakrit's account owned a brand-new, empty
 * workspace and still carried an accepted co-manager link to Ambika, so the
 * old rule ("owns no houses + has a link = pure co-manager, show the inviter's
 * number") put Ambika's line and address inside HIS workspace. Texts went out
 * from her number; replies landed in her inbox.
 */
import { describe, expect, it } from "vitest";
import { createWorkspaceMemoryDb } from "./support/workspace-memory-db";
import {
  resolveViewerWorkNumber,
  resolveWorkspaceOwnerForWorkNumber,
  resolveWorkspaceWorkNumbers,
  resolveOwnerSendNumberRow,
} from "@/lib/sms/manager-workspace-role.server";
import { resolveActiveWorkspace } from "@/lib/workspaces/active.server";
import { provisionManagerNumber, getManagerNumberRecord } from "@/lib/sms/manager-number-provisioning.server";
import {
  ensureManagerAssistantEmail,
  resolveWorkspaceWorkEmail,
  resolveWorkspaceWorkEmails,
  WorkspaceNotOwnedError,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { resolveOwnedWorkNumber } from "@/lib/sms/resolve-owned-work-number.server";
import { conversationVisible, type CommunicationScope } from "@/lib/communication/conversation-visibility.server";

const ambika = "ambika", prakrit = "prakrit", solo = "solo";
const AMBIKA_WS = "ws-ambika", PRAKRIT_WS = "ws-prakrit", PRAKRIT_WS2 = "ws-prakrit-seattle";

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createWorkspaceMemoryDb({
    profiles: [
      { id: ambika, full_name: "Ambika Mago", email: "ambika@example.com", role: "manager", sms_from_number: "+12066781909" },
      { id: prakrit, full_name: "Prakrit Ramachandran", email: "prakrit@example.com", role: "manager", sms_from_number: null },
      { id: solo, full_name: "Solo", email: "solo@example.com", role: "manager", sms_from_number: null },
    ],
    profile_roles: [],
    portal_workspaces: [
      { id: AMBIKA_WS, owner_user_id: ambika, name: "Ambika's workspace", is_default: true, created_at: "2026-01-01" },
      { id: PRAKRIT_WS, owner_user_id: prakrit, name: "My workspace", is_default: true, created_at: "2026-02-01" },
    ],
    manager_property_records: [
      { id: "jain-home", manager_user_id: ambika, workspace_id: AMBIKA_WS, row_data: { buildingName: "Jain Home" } },
    ],
    manager_sms_numbers: [
      { id: "n-ambika", manager_user_id: ambika, workspace_id: AMBIKA_WS, phone_number: "+12066781909", provision_state: "active", messaging_service_sid: "MG1" },
    ],
    manager_assistant_emails: [
      { id: "e-ambika", manager_user_id: ambika, workspace_id: AMBIKA_WS, inbox_token: "AbCdEf123456", mailbox_local: "assist-ambika-mago", provision_state: "active" },
    ],
    // Prakrit is (still) an accepted co-manager on Ambika's house.
    account_link_invites: [
      {
        inviter_user_id: ambika,
        invitee_user_id: prakrit,
        status: "accepted",
        assigned_property_ids: ["jain-home"],
        property_co_manager_permissions: { "jain-home": { inbox: true, properties: { read: true } } },
      },
    ],
    ...extra,
  });
}

describe("the bug: an empty owned workspace never shows another workspace's line", () => {
  it("Prakrit's own workspace has NO number, even though he is Ambika's co-manager", async () => {
    const db = seed();
    const mine = await resolveViewerWorkNumber(db as never, prakrit, PRAKRIT_WS);
    expect(mine).toMatchObject({ workspaceId: PRAKRIT_WS, owned: true, phoneNumber: null });
    expect(mine?.phoneNumber).not.toBe("+12066781909");
  });

  it("…and no work email either", async () => {
    const db = seed();
    const mine = await resolveWorkspaceWorkEmail(db as never, prakrit, PRAKRIT_WS);
    expect(mine).toMatchObject({ workspaceId: PRAKRIT_WS, owned: true, address: null });
  });

  it("inside Ambika's workspace he reads HER line for THAT workspace, read-only", async () => {
    const db = seed();
    const shared = await resolveViewerWorkNumber(db as never, prakrit, AMBIKA_WS);
    expect(shared).toMatchObject({
      workspaceId: AMBIKA_WS,
      owned: false,
      ownerUserId: ambika,
      ownerName: "Ambika Mago",
      phoneNumber: "+12066781909",
    });
  });

  it("with no selection, the viewer's OWN default workspace wins — never the shared one", async () => {
    const db = seed();
    await expect(resolveActiveWorkspace(db as never, prakrit, null)).resolves.toMatchObject({ id: PRAKRIT_WS, owned: true });
    await expect(resolveActiveWorkspace(db as never, prakrit, "ws-not-mine")).resolves.toMatchObject({ id: PRAKRIT_WS });
  });

  it("the list is one entry per workspace the viewer can see: owned first", async () => {
    const db = seed();
    const { numbers } = await resolveWorkspaceWorkNumbers(db as never, prakrit);
    expect(numbers.map((n) => [n.workspaceId, n.owned, n.phoneNumber])).toEqual([
      [PRAKRIT_WS, true, null],
      [AMBIKA_WS, false, "+12066781909"],
    ]);
    const { emails } = await resolveWorkspaceWorkEmails(db as never, prakrit);
    expect(emails.map((e) => [e.workspaceId, e.address])).toEqual([
      [PRAKRIT_WS, null],
      [AMBIKA_WS, "assist-ambika-mago@prop-lane.space"],
    ]);
  });
});

describe("a manager can set up a line and an address in each workspace they own", () => {
  it("provisioning is keyed on the workspace, so a second workspace gets its own row", async () => {
    const db = seed({
      portal_workspaces: [
        { id: AMBIKA_WS, owner_user_id: ambika, name: "Ambika's workspace", is_default: true, created_at: "2026-01-01" },
        { id: PRAKRIT_WS, owner_user_id: prakrit, name: "My workspace", is_default: true, created_at: "2026-02-01" },
        { id: PRAKRIT_WS2, owner_user_id: prakrit, name: "Seattle rentals", is_default: false, created_at: "2026-03-01" },
      ],
    });
    // Provisioning is disabled in tests, so each call parks a row for ITS workspace.
    const first = await provisionManagerNumber(db as never, prakrit, { workspaceId: PRAKRIT_WS });
    const second = await provisionManagerNumber(db as never, prakrit, { workspaceId: PRAKRIT_WS2 });
    expect(first).toMatchObject({ ok: false, error: "provisioning_disabled", state: "pending_registration" });
    expect(second).toMatchObject({ ok: false, error: "provisioning_disabled", state: "pending_registration" });
    const rows = db.__tables.manager_sms_numbers.filter((r) => r.manager_user_id === prakrit);
    expect(rows.map((r) => r.workspace_id).sort()).toEqual([PRAKRIT_WS, PRAKRIT_WS2].sort());
  });

  it("a workspace you do not own is refused — no purchase, no row", async () => {
    const db = seed();
    const result = await provisionManagerNumber(db as never, prakrit, { workspaceId: AMBIKA_WS });
    expect(result).toEqual({ ok: false, error: "workspace_not_owned", state: "pending_registration" });
    expect(db.__tables.manager_sms_numbers.filter((r) => r.manager_user_id === prakrit)).toHaveLength(0);
  });

  it("minting an address is per workspace too, and refused on a shared one", async () => {
    const db = seed({
      portal_workspaces: [
        { id: AMBIKA_WS, owner_user_id: ambika, name: "Ambika's workspace", is_default: true, created_at: "2026-01-01" },
        { id: PRAKRIT_WS, owner_user_id: prakrit, name: "My workspace", is_default: true, created_at: "2026-02-01" },
        { id: PRAKRIT_WS2, owner_user_id: prakrit, name: "Seattle rentals", is_default: false, created_at: "2026-03-01" },
      ],
    });
    const mine = { id: PRAKRIT_WS, ownerUserId: prakrit, owned: true, isDefault: true };
    const second = { id: PRAKRIT_WS2, ownerUserId: prakrit, owned: true, isDefault: false };
    const a = await ensureManagerAssistantEmail(db as never, prakrit, mine);
    const b = await ensureManagerAssistantEmail(db as never, prakrit, second);
    expect(a.workspaceId).toBe(PRAKRIT_WS);
    expect(b.workspaceId).toBe(PRAKRIT_WS2);
    expect(a.address).not.toBe(b.address);
    await expect(
      ensureManagerAssistantEmail(db as never, prakrit, { id: AMBIKA_WS, ownerUserId: ambika, owned: false, isDefault: true }),
    ).rejects.toBeInstanceOf(WorkspaceNotOwnedError);
    expect(await resolveWorkspaceWorkEmail(db as never, prakrit, PRAKRIT_WS2)).toMatchObject({ address: b.address });
  });

  it("the legacy per-user read means the owner's DEFAULT workspace's row", async () => {
    const db = seed({
      manager_sms_numbers: [
        { id: "n-p1", manager_user_id: prakrit, workspace_id: PRAKRIT_WS, phone_number: "+12065550001", provision_state: "active" },
        { id: "n-p2", manager_user_id: prakrit, workspace_id: PRAKRIT_WS2, phone_number: "+12065550002", provision_state: "active" },
      ],
      portal_workspaces: [
        { id: PRAKRIT_WS, owner_user_id: prakrit, name: "My workspace", is_default: true, created_at: "2026-02-01" },
        { id: PRAKRIT_WS2, owner_user_id: prakrit, name: "Seattle rentals", is_default: false, created_at: "2026-03-01" },
      ],
    });
    await expect(getManagerNumberRecord(db as never, prakrit)).resolves.toMatchObject({ phoneNumber: "+12065550001" });
    await expect(getManagerNumberRecord(db as never, prakrit, PRAKRIT_WS2)).resolves.toMatchObject({ phoneNumber: "+12065550002" });
  });
});

describe("inbound follows the line, not the person", () => {
  it("a texted number resolves to its workspace, and that workspace's owner", async () => {
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG1";
    const db = seed();
    const owned = await resolveOwnedWorkNumber(db as never, "+1 (206) 678-1909");
    expect(owned).toEqual({ managerId: ambika, workspaceId: AMBIKA_WS, messagingServiceSid: "MG1" });
    await expect(
      resolveWorkspaceOwnerForWorkNumber(db as never, owned!.managerId, { workspaceId: owned!.workspaceId }),
    ).resolves.toEqual({ ownerUserId: ambika, sharedFromCoManager: false, workspaceId: AMBIKA_WS });
  });

  it("a legacy row with no workspace still collapses a pure co-manager's line to the inviter", async () => {
    const db = seed({
      manager_sms_numbers: [
        { id: "n-legacy", manager_user_id: prakrit, workspace_id: null, phone_number: "+12065559999", provision_state: "active", messaging_service_sid: "MG1" },
      ],
    });
    await expect(resolveWorkspaceOwnerForWorkNumber(db as never, prakrit, { workspaceId: null })).resolves.toEqual({
      ownerUserId: ambika,
      sharedFromCoManager: true,
      workspaceId: null,
    });
  });
});

describe("outbound goes out from the line of the workspace the message is about", () => {
  const cols = "manager_user_id, workspace_id, phone_number, provision_state";
  const two = () =>
    seed({
      manager_sms_numbers: [
        { id: "n-p1", manager_user_id: prakrit, workspace_id: PRAKRIT_WS, phone_number: "+12065550001", provision_state: "active" },
        { id: "n-p2", manager_user_id: prakrit, workspace_id: PRAKRIT_WS2, phone_number: "+12065550002", provision_state: "active" },
      ],
      portal_workspaces: [
        { id: PRAKRIT_WS, owner_user_id: prakrit, name: "My workspace", is_default: true, created_at: "2026-02-01" },
        { id: PRAKRIT_WS2, owner_user_id: prakrit, name: "Seattle rentals", is_default: false, created_at: "2026-03-01" },
      ],
      manager_property_records: [
        { id: "ballard-room", manager_user_id: prakrit, workspace_id: PRAKRIT_WS2, row_data: {} },
      ],
    });

  it("a message about a house uses that house's workspace line", async () => {
    const { data } = await resolveOwnerSendNumberRow<{ phone_number: string }>(two() as never, prakrit, cols, { propertyId: "ballard-room" });
    expect(data?.phone_number).toBe("+12065550002");
  });

  it("a message about no house uses the default workspace's line", async () => {
    const { data } = await resolveOwnerSendNumberRow<{ phone_number: string }>(two() as never, prakrit, cols, {});
    expect(data?.phone_number).toBe("+12065550001");
  });
});

describe("a conversation about no house shows in the workspace whose line carried it", () => {
  const scope = (active: string): CommunicationScope => ({
    viewerId: prakrit,
    level: "read",
    ownerIds: [prakrit],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: new Set(),
    untaggedOwnedVisible: active === PRAKRIT_WS,
    activeWorkspaceId: active,
    workspaceByLine: new Map([
      ["2065550001", PRAKRIT_WS],
      ["2065550002", PRAKRIT_WS2],
      ["assist-seattle@prop-lane.space", PRAKRIT_WS2],
    ]),
  });

  it("a text to the second workspace's number shows there, and only there", () => {
    const input = { ownerId: prakrit, houseIds: [], lines: ["+1 (206) 555-0002"] };
    expect(conversationVisible(scope(PRAKRIT_WS2), input)).toBe(true);
    expect(conversationVisible(scope(PRAKRIT_WS), input)).toBe(false);
  });

  it("an email to the second workspace's address does the same", () => {
    const input = { ownerId: prakrit, houseIds: [], lines: ["Assist-Seattle@prop-lane.space"] };
    expect(conversationVisible(scope(PRAKRIT_WS2), input)).toBe(true);
    expect(conversationVisible(scope(PRAKRIT_WS), input)).toBe(false);
  });

  it("with no line to place it, today's rule stands: the owner's default workspace", () => {
    const input = { ownerId: prakrit, houseIds: [] };
    expect(conversationVisible(scope(PRAKRIT_WS), input)).toBe(true);
    expect(conversationVisible(scope(PRAKRIT_WS2), input)).toBe(false);
  });
});
