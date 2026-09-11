/**
 * A work number is the WORKSPACE's front door. A prospect texting a
 * co-manager's line used to get "This is a co-manager's PropLane assistant
 * number… message your property manager" no matter what they typed. The line
 * now answers for the owner whose houses the co-manager holds, so the leasing
 * agent leases the owner's houses and the reply still leaves from the line
 * that was texted.
 */
import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { resolveWorkspaceOwnerForWorkNumber } from "@/lib/sms/manager-workspace-role.server";

const owner = "owner", other = "other-owner", co = "co";

function seed(links: Record<string, unknown>[]) {
  return createMemoryDb({
    profiles: [{ id: owner }, { id: other }, { id: co }],
    manager_property_records: [
      { id: "house-a", manager_user_id: owner },
      { id: "house-b", manager_user_id: owner },
      { id: "house-c", manager_user_id: other },
    ],
    account_link_invites: links,
  });
}

describe("resolveWorkspaceOwnerForWorkNumber", () => {
  it("an owner's own line answers for themselves", async () => {
    const db = seed([]);
    await expect(resolveWorkspaceOwnerForWorkNumber(db as never, owner)).resolves.toEqual({
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
    await expect(resolveWorkspaceOwnerForWorkNumber(db as never, co)).resolves.toEqual({
      ownerUserId: other,
      sharedFromCoManager: true,
    });
  });

  it("a co-manager with no accepted link keeps their own scope (nothing to lease)", async () => {
    const db = seed([{ inviter_user_id: owner, invitee_user_id: co, status: "pending", assigned_property_ids: ["house-a"] }]);
    await expect(resolveWorkspaceOwnerForWorkNumber(db as never, co)).resolves.toEqual({
      ownerUserId: co,
      sharedFromCoManager: false,
    });
  });
});
