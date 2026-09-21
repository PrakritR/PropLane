/**
 * `managerHasCoManagerPermissionForProperty` is the per-property primitive that
 * household charges, vendors, applications and team invites call directly,
 * without the module wrappers.
 *
 * It carried its own copy of the empty-means-full sentinel PRP-199 retired, so
 * a delegate whose grant `describeCoManagerPermissions` reports as "No access to
 * any module" could still edit and delete the owner's charges and vendors long
 * after the gate above it had been closed. One rule, everywhere.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";

const OWNER = "owner-1";
const DELEGATE = "delegate-1";
const PROPERTY = "prop-1";

let propertyOwner: string | null = OWNER;
let linkRows: Array<{
  inviter_user_id: string;
  invitee_user_id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
}> = [];

function makeDb() {
  return {
    from(table: string) {
      const settle = () => {
        if (table === "manager_property_records") {
          return { data: { manager_user_id: propertyOwner }, error: null };
        }
        if (table === "account_link_invites") return { data: linkRows, error: null };
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: async () => ({ data: [] }),
        maybeSingle: async () => settle(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
      };
      return builder;
    },
  } as never;
}

function grant(permissions: unknown, assigned: string[] = [PROPERTY]) {
  return [
    {
      inviter_user_id: OWNER,
      invitee_user_id: DELEGATE,
      assigned_property_ids: assigned,
      property_co_manager_permissions: permissions,
    },
  ];
}

beforeEach(() => {
  propertyOwner = OWNER;
  linkRows = [];
});

describe("an empty grant confers nothing here either", () => {
  it("denies every module the direct callers ask about", async () => {
    linkRows = grant({ [PROPERTY]: {} });

    for (const permission of ["payments", "services", "applications", "residents"] as const) {
      for (const level of ["read", "edit", "delete"] as const) {
        const allowed = await managerHasCoManagerPermissionForProperty(
          makeDb(),
          DELEGATE,
          PROPERTY,
          permission,
          level,
        );
        expect(allowed, `${permission}/${level}`).toBe(false);
      }
    }
  });
});

describe("explicit grants keep working", () => {
  it("honours the level named and refuses the ones that are not", async () => {
    linkRows = grant({ [PROPERTY]: { payments: { read: true, edit: true } } });
    const db = makeDb();

    expect(await managerHasCoManagerPermissionForProperty(db, DELEGATE, PROPERTY, "payments", "read")).toBe(true);
    expect(await managerHasCoManagerPermissionForProperty(db, DELEGATE, PROPERTY, "payments", "edit")).toBe(true);
    expect(await managerHasCoManagerPermissionForProperty(db, DELEGATE, PROPERTY, "payments", "delete")).toBe(false);
    expect(await managerHasCoManagerPermissionForProperty(db, DELEGATE, PROPERTY, "services", "edit")).toBe(false);
  });

  it("does not reach a property the link never assigned", async () => {
    linkRows = grant({ "prop-other": { payments: { read: true, edit: true } } }, ["prop-other"]);

    expect(
      await managerHasCoManagerPermissionForProperty(makeDb(), DELEGATE, PROPERTY, "payments", "edit"),
    ).toBe(false);
  });
});

describe("the property owner", () => {
  it("passes on their own property with no link at all", async () => {
    linkRows = [];

    expect(
      await managerHasCoManagerPermissionForProperty(makeDb(), OWNER, PROPERTY, "payments", "delete"),
    ).toBe(true);
  });

  it("is not confused by an ownerless property row", async () => {
    propertyOwner = null;
    linkRows = [];

    expect(
      await managerHasCoManagerPermissionForProperty(makeDb(), OWNER, PROPERTY, "payments", "edit"),
    ).toBe(false);
  });
});
