/**
 * One work number per WORKSPACE.
 *
 * Every manager-role account used to be bought its own Twilio line, and a
 * prospect texting a co-manager's line got "This is a co-manager's PropLane
 * assistant number… message your property manager" whatever they typed. Now
 * the number belongs to the workspace: a co-manager with no houses of their
 * own reads and sends from the owner's line, is never bought one, and a
 * legacy line they still hold answers for the owner's workspace.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import {
  listWorkspaceOwnersForCoManager,
  resolveWorkspaceOwnerForWorkNumber,
  resolveWorkspaceWorkNumbers,
} from "@/lib/sms/manager-workspace-role.server";
import { provisionManagerNumber } from "@/lib/sms/manager-number-provisioning.server";
import { listManagersNeedingWorkNumbers } from "@/lib/backfill-manager-work-numbers.server";

const owner = "owner", other = "other-owner", co = "co", solo = "solo";

function seed(links: Record<string, unknown>[], extra: Record<string, Record<string, unknown>[]> = {}) {
  return createMemoryDb({
    profiles: [
      { id: owner, full_name: "Prakrit Ramachandran", email: "p@example.com", role: "manager", sms_from_number: "+12065550199" },
      { id: other, full_name: "", email: "maya@example.com", role: "manager", sms_from_number: null },
      { id: co, full_name: "Akhil", email: "a@example.com", role: "manager", sms_from_number: null },
      { id: solo, full_name: "Solo", email: "s@example.com", role: "manager", sms_from_number: null },
    ],
    profile_roles: [],
    manager_property_records: [
      { id: "house-a", manager_user_id: owner },
      { id: "house-b", manager_user_id: owner },
      { id: "house-c", manager_user_id: other },
    ],
    manager_sms_numbers: [
      { manager_user_id: owner, phone_number: "+12065550199", provision_state: "active" },
    ],
    account_link_invites: links,
    ...extra,
  });
}

describe("resolveWorkspaceOwnerForWorkNumber", () => {
  it("an owner's own line answers for themselves", async () => {
    await expect(resolveWorkspaceOwnerForWorkNumber(seed([]) as never, owner)).resolves.toEqual({
      ownerUserId: owner,
      sharedFromCoManager: false,
    });
  });

  it("a pure co-manager's line answers for the owner whose houses they hold", async () => {
    const db = seed([
      { inviter_user_id: owner, invitee_user_id: co, status: "accepted", assigned_property_ids: ["house-a", "house-b"] },
    ]);
    await expect(resolveWorkspaceOwnerForWorkNumber(db as never, co)).resolves.toEqual({
      ownerUserId: owner,
      sharedFromCoManager: true,
    });
  });

  it("with several owners, the one with the most houses assigned wins", async () => {
    const db = seed([
      { inviter_user_id: owner, invitee_user_id: co, status: "accepted", assigned_property_ids: ["house-a"] },
      { inviter_user_id: other, invitee_user_id: co, status: "accepted", assigned_property_ids: ["house-c", "house-d"] },
    ]);
    await expect(resolveWorkspaceOwnerForWorkNumber(db as never, co)).resolves.toMatchObject({ ownerUserId: other });
    await expect(listWorkspaceOwnersForCoManager(db as never, co)).resolves.toEqual([
      { ownerUserId: other, houses: 2 },
      { ownerUserId: owner, houses: 1 },
    ]);
  });

  it("a manager with no accepted link is the owner of their own (empty) workspace", async () => {
    const db = seed([{ inviter_user_id: owner, invitee_user_id: co, status: "pending", assigned_property_ids: ["house-a"] }]);
    await expect(resolveWorkspaceOwnerForWorkNumber(db as never, co)).resolves.toEqual({
      ownerUserId: co,
      sharedFromCoManager: false,
    });
  });
});

describe("resolveWorkspaceWorkNumbers — what an account reads and sends from", () => {
  it("a co-manager gets the owner's number, named, and never one of their own", async () => {
    const db = seed([
      { inviter_user_id: owner, invitee_user_id: co, status: "accepted", assigned_property_ids: ["house-a"] },
    ]);
    await expect(resolveWorkspaceWorkNumbers(db as never, co)).resolves.toEqual({
      role: "co_manager",
      numbers: [
        { ownerUserId: owner, ownerName: "Prakrit Ramachandran", phoneNumber: "+12065550199", provisionState: "active" },
      ],
    });
  });

  it("a workspace whose owner has no number yet is still listed, so the UI can say whose job it is", async () => {
    const db = seed([
      { inviter_user_id: other, invitee_user_id: co, status: "accepted", assigned_property_ids: ["house-c"] },
    ]);
    const { numbers } = await resolveWorkspaceWorkNumbers(db as never, co);
    // No full name on file: the email stands in so the sentence still names someone.
    expect(numbers).toEqual([{ ownerUserId: other, ownerName: "maya@example.com", phoneNumber: null, provisionState: null }]);
  });

  it("an owner reads their own row", async () => {
    await expect(resolveWorkspaceWorkNumbers(seed([]) as never, owner)).resolves.toMatchObject({
      role: "primary",
      numbers: [{ ownerUserId: owner, phoneNumber: "+12065550199" }],
    });
  });
});

describe("nobody buys a co-manager a second number for the same workspace", () => {
  const link = { inviter_user_id: owner, invitee_user_id: co, status: "accepted", assigned_property_ids: ["house-a"] };

  it("the provisioner refuses before touching the number record", async () => {
    const db = seed([link]);
    const result = await provisionManagerNumber(db as never, co);
    expect(result).toEqual({ ok: false, error: "workspace_number_shared", state: "pending_registration" });
    expect(db.__tables.manager_sms_numbers.some((r) => r.manager_user_id === co)).toBe(false);
  });

  it("the signup / repair backfill skips pure co-managers and keeps everyone else", async () => {
    const db = seed([link]);
    const candidates = await listManagersNeedingWorkNumbers(db as never);
    const ids = candidates.map((c) => c.userId);
    expect(ids).not.toContain(co);
    expect(ids).toContain(other);
    expect(ids).toContain(solo);
  });
});

describe("the inbound webhook answers for the workspace", () => {
  const route = readFileSync("src/app/api/twilio/inbound/route.ts", "utf8");

  it("the co-manager bounce is gone from the codebase", () => {
    expect(route).not.toContain("co-manager's PropLane assistant number");
    expect(route).not.toContain("routingReply");
  });

  it("collapses the texted line to its workspace owner before any resident or leasing lookup", () => {
    const collapse = route.indexOf("resolveWorkspaceOwnerForWorkNumber(db, numberOwnerId");
    expect(collapse).toBeGreaterThan(-1);
    expect(collapse).toBeLessThan(route.indexOf("resolveManagerSmsInboundIdentity(db"));
    expect(collapse).toBeLessThan(route.indexOf("handleClawLeasingInbound("));
  });
});
