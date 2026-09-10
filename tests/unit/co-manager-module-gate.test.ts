/**
 * `assertCoManagerModuleAccess` is THE write gate for every per-property module
 * route — bills (financials), documents, promotions, properties, applications.
 *
 * It used to resolve through `managerHasCoManagerPermissionForProperty`, whose
 * `if (Object.keys(flat).length === 0) return true;` reads an assignment with no
 * checked permissions as full access at every level — the empty-means-full
 * sentinel PRP-199 retired. For a while there were two same-shaped gates with
 * opposite posture and the shorter name was the fail-open one; there is now one,
 * and these pin what it answers.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  assertCoManagerModuleAccess,
  assertManagerDocumentsCoManagerAccess,
  assertManagerFinancialsCoManagerAccess,
  assertManagerPromotionCoManagerAccess,
} from "@/lib/auth/co-manager-access";

const OWNER = "owner-1";
const OTHER_OWNER = "owner-2";
const DELEGATE = "delegate-1";
const PROPERTY = "prop-1";

type LinkRow = {
  inviter_user_id: string;
  invitee_user_id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
};

let linkRows: LinkRow[] = [];
let propertyOwner: string | null = OWNER;

function makeDb() {
  return {
    from(table: string) {
      const settle = () => {
        if (table === "account_link_invites") return { data: linkRows, error: null };
        if (table === "manager_property_records") {
          return { data: { manager_user_id: propertyOwner }, error: null };
        }
        return { data: { id: DELEGATE, email: "delegate@example.com" }, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: async () => ({
          data: [
            { id: OWNER, email: "owner@example.com" },
            { id: OTHER_OWNER, email: "other@example.com" },
            { id: DELEGATE, email: "delegate@example.com" },
          ],
        }),
        maybeSingle: async () => settle(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
      };
      return builder;
    },
  } as never;
}

function grant(permissions: unknown, assigned: string[] = [PROPERTY], inviter = OWNER): LinkRow[] {
  return [
    {
      inviter_user_id: inviter,
      invitee_user_id: DELEGATE,
      assigned_property_ids: assigned,
      property_co_manager_permissions: permissions,
    },
  ];
}

beforeEach(() => {
  linkRows = [];
  propertyOwner = OWNER;
});

describe("an assignment with NO checked permissions confers nothing", () => {
  it("denies every module at every level", async () => {
    linkRows = grant({ [PROPERTY]: {} });

    for (const permission of ["financials", "documents", "promotion", "properties"] as const) {
      for (const level of ["read", "edit", "delete"] as const) {
        const result = await assertCoManagerModuleAccess(makeDb(), DELEGATE, PROPERTY, permission, {
          ownerManagerUserId: OWNER,
          level,
        });
        expect(result, `${permission}/${level}`).toEqual({
          ok: false,
          status: 403,
          error: "You do not have access to this section for this property.",
        });
      }
    }
  });

  it("denies through every module wrapper the routes actually call", async () => {
    linkRows = grant({ [PROPERTY]: {} });
    const db = makeDb();

    expect((await assertManagerFinancialsCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "edit")).ok).toBe(false);
    expect((await assertManagerDocumentsCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "edit")).ok).toBe(false);
    expect((await assertManagerDocumentsCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "delete")).ok).toBe(false);
    expect((await assertManagerPromotionCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "delete")).ok).toBe(false);
  });
});

describe("a real grant is honoured at exactly the level given", () => {
  it("lets read-only view but not edit or delete", async () => {
    linkRows = grant({ [PROPERTY]: { documents: { read: true } } });
    const db = makeDb();

    expect((await assertManagerDocumentsCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "read")).ok).toBe(true);
    expect((await assertManagerDocumentsCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "edit")).ok).toBe(false);
    expect((await assertManagerDocumentsCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "delete")).ok).toBe(false);
  });

  it("does not let one module's grant carry another", async () => {
    linkRows = grant({ [PROPERTY]: { documents: { read: true, edit: true } } });
    const db = makeDb();

    expect((await assertManagerDocumentsCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "edit")).ok).toBe(true);
    expect((await assertManagerFinancialsCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "edit")).ok).toBe(false);
    expect((await assertManagerPromotionCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "edit")).ok).toBe(false);
  });

  it("allows the level it names", async () => {
    linkRows = grant({ [PROPERTY]: { promotion: { read: true, delete: true } } });
    const db = makeDb();

    expect((await assertManagerPromotionCoManagerAccess(db, DELEGATE, PROPERTY, OWNER, "delete")).ok).toBe(true);
  });
});

describe("the grant is bound to a property and an owner", () => {
  it("does not reach a property the link never assigned", async () => {
    linkRows = grant({ "prop-other": { financials: { read: true, edit: true } } }, ["prop-other"]);

    const result = await assertManagerFinancialsCoManagerAccess(makeDb(), DELEGATE, PROPERTY, OWNER, "edit");

    expect(result.ok).toBe(false);
  });

  it("does not authorize acting on a THIRD manager's row on that property", async () => {
    linkRows = grant({ [PROPERTY]: { documents: { read: true, edit: true } } });

    const mine = await assertManagerDocumentsCoManagerAccess(makeDb(), DELEGATE, PROPERTY, OWNER, "edit");
    const theirs = await assertManagerDocumentsCoManagerAccess(makeDb(), DELEGATE, PROPERTY, OTHER_OWNER, "edit");

    expect(mine.ok).toBe(true);
    expect(theirs.ok).toBe(false);
  });

  it("carries an OWNERLESS row on the property grant alone", async () => {
    // `manager_user_id` is `on delete set null`, so a deleted manager leaves
    // rows with no owner to pair the grant with.
    linkRows = grant({ [PROPERTY]: { documents: { read: true, edit: true } } });

    const result = await assertManagerDocumentsCoManagerAccess(makeDb(), DELEGATE, PROPERTY, "", "edit");

    expect(result.ok).toBe(true);
  });
});

describe("the property owner is recognised without being told who they are", () => {
  it("passes on a property they own when the caller supplies no owner", async () => {
    // The bills route deliberately passes `undefined` here: handing the gate the
    // caller would short-circuit it into a no-op. The property record's own
    // `manager_user_id` is what admits the owner, and it has to, because
    // `linkedOwnerScopeForModule` reads links by `invitee_user_id` and an owner
    // is the inviter.
    linkRows = [];

    const result = await assertManagerFinancialsCoManagerAccess(makeDb(), OWNER, PROPERTY, undefined, "edit");

    expect(result.ok).toBe(true);
  });

  it("does not admit a non-owner through that lookup", async () => {
    linkRows = [];

    const result = await assertManagerFinancialsCoManagerAccess(makeDb(), DELEGATE, PROPERTY, undefined, "edit");

    expect(result.ok).toBe(false);
  });

  it("admits nobody when the property row has no owner", async () => {
    propertyOwner = null;
    linkRows = [];

    const result = await assertManagerFinancialsCoManagerAccess(makeDb(), OWNER, PROPERTY, undefined, "edit");

    expect(result.ok).toBe(false);
  });
});

describe("the owner and the unassigned-row case", () => {
  it("lets the owner through without consulting any link", async () => {
    linkRows = [];

    const result = await assertManagerFinancialsCoManagerAccess(makeDb(), OWNER, PROPERTY, OWNER, "delete");

    expect(result.ok).toBe(true);
  });

  it("lets a caller act on their own row that names no property", async () => {
    // A bill with no property is the caller's own; there is nothing to scope.
    linkRows = [];

    const result = await assertManagerFinancialsCoManagerAccess(makeDb(), DELEGATE, null, undefined, "edit");

    expect(result.ok).toBe(true);
  });

  it("still refuses another manager's row that names no property", async () => {
    linkRows = grant({ [PROPERTY]: { documents: { read: true, edit: true } } });

    const result = await assertManagerDocumentsCoManagerAccess(makeDb(), DELEGATE, null, OWNER, "edit");

    expect(result.ok).toBe(false);
  });
});
