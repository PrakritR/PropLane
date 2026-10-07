/**
 * The menu is not the security boundary. An accepted Property owner row, even
 * one whose stored map was forged to carry every module at Manage, grants
 * nothing through any existing manager gate: linked houses, per-module scope,
 * the module write gate, owner attribution and tier inheritance.
 */
import { describe, expect, it } from "vitest";

import { assertCoManagerModuleAccess } from "@/lib/auth/co-manager-access";
import { linkedOwnerForProperty, linkedOwnerScopeForModule, linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { collectLinkedPropertyIdsForUser, collectLinkedPropertyPermissionsForUser } from "@/lib/auth/manager-lease-scope";
import { buildAllModulesGrant, CO_MANAGER_PERMISSION_OPTIONS } from "@/lib/co-manager-permissions";
import { makeFakeDb } from "./property-owner-fake-db";

const MANAGER = "manager-1";
const PERSON = "person-1";
const HOUSE = "house-a";

function tables(teamRole: string | null) {
  return {
    account_link_invites: [
      {
        inviter_user_id: MANAGER,
        invitee_user_id: PERSON,
        status: "accepted",
        team_role: teamRole,
        house_scope: "selected",
        assigned_property_ids: [HOUSE],
        // Forged: every module at full access, plus the owner keys.
        property_co_manager_permissions: { [HOUSE]: { ...buildAllModulesGrant("full"), ownerPerformance: true } },
        co_manager_permissions: buildAllModulesGrant("full"),
      },
    ],
    profiles: [
      { id: PERSON, email: "person@example.com" },
      { id: MANAGER, email: "manager@example.com" },
    ],
    manager_property_records: [{ id: HOUSE, manager_user_id: MANAGER }],
  };
}

describe("an owner row grants nothing through any existing manager gate", () => {
  const db = makeFakeDb(tables("property_owner"));

  it("is not a linked house, and carries no linked permissions", async () => {
    expect([...(await collectLinkedPropertyIdsForUser(db, PERSON))]).toEqual([]);
    expect((await collectLinkedPropertyPermissionsForUser(db, PERSON)).size).toBe(0);
  });

  it("reaches no house for any module", async () => {
    for (const { id } of CO_MANAGER_PERMISSION_OPTIONS) {
      expect([...(await linkedPropertyIdsForModule(db, PERSON, id))], id).toEqual([]);
      const scope = await linkedOwnerScopeForModule(db, PERSON, id, "edit");
      expect(scope.ownerIds.size, id).toBe(0);
      expect(scope.propertyIds.size, id).toBe(0);
    }
  });

  it("does not attribute a new row to the manager", async () => {
    expect(await linkedOwnerForProperty(db, PERSON, HOUSE)).toBeNull();
  });

  it("is refused 403 by the module write gate at every level", async () => {
    for (const { id } of CO_MANAGER_PERMISSION_OPTIONS) {
      for (const level of ["read", "edit", "delete"] as const) {
        const result = await assertCoManagerModuleAccess(db, PERSON, HOUSE, id, { ownerManagerUserId: MANAGER, level });
        expect(result, `${id}/${level}`).toMatchObject({ ok: false, status: 403 });
      }
    }
  });
});

describe("control: the same forged row as a real role does grant, so the filter is what refuses", () => {
  it("a viewer row with the same map reaches the house", async () => {
    const db = makeFakeDb(tables("viewer"));
    expect([...(await linkedPropertyIdsForModule(db, PERSON, "financials"))]).toEqual([HOUSE]);
    expect(await linkedOwnerForProperty(db, PERSON, HOUSE)).toBe(MANAGER);
  });

  it("a legacy row with no team_role still reaches it (a NULL role is not an owner)", async () => {
    const db = makeFakeDb(tables(null));
    expect([...(await linkedPropertyIdsForModule(db, PERSON, "financials"))]).toEqual([HOUSE]);
  });
});
