/**
 * `getShareablePropertyForUser` is the ONE gate behind AI listing copy
 * generation, lead invites, tour booking, and the agent's `share_listing`
 * tool — all performed AS THE OWNER. It used to treat mere assignment
 * (`assigned_property_ids`) as authorization, with no module check — a
 * co-manager assigned a property with an EMPTY permission map could still
 * share it. It now requires `promotion` at edit
 * (docs/agents/co-manager-access.md "Empty used to mean FULL"), except for
 * the drifted-ownership fallback where the caller is the link's own inviter
 * (still the owner side of the relationship, not a co-manager grant).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const isAdminUser = vi.fn();
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

const { getShareablePropertyForUser } = await import("@/lib/manager-property-share-access");

const OWNER = "owner-1";
const DRIFTED_OWNER = "current-owner-2";
const DELEGATE = "delegate-1";
const PROPERTY = "prop-1";

const LIVE_PROPERTY = { id: PROPERTY, address: "123 Main St", adminPublishLive: true, title: "123 Main St" };

type LinkRow = {
  inviter_user_id: string;
  invitee_user_id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
};

let linkRows: LinkRow[] = [];
let propertyRecord: Record<string, unknown> = {};

function makeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> & { eqCol?: string; eqVal?: string } = {
        select: () => builder,
        eq: (column: string, value: string) => {
          if (column === "invitee_user_id" || column === "inviter_user_id") {
            builder.eqCol = column;
            builder.eqVal = value;
          }
          return builder;
        },
        maybeSingle: async () => {
          if (table === "manager_property_records") return { data: propertyRecord, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => {
          let data: unknown[] = [];
          if (table === "account_link_invites") {
            data = linkRows.filter((row) => {
              if (builder.eqCol === "invitee_user_id") return row.invitee_user_id === builder.eqVal;
              if (builder.eqCol === "inviter_user_id") return row.inviter_user_id === builder.eqVal;
              return true;
            });
          }
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

function grant(permissions: unknown): LinkRow[] {
  return [
    {
      inviter_user_id: OWNER,
      invitee_user_id: DELEGATE,
      assigned_property_ids: [PROPERTY],
      property_co_manager_permissions: permissions,
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  isAdminUser.mockResolvedValue(false);
  linkRows = [];
  propertyRecord = { manager_user_id: OWNER, status: "live", property_data: LIVE_PROPERTY };
});

describe("getShareablePropertyForUser — co-manager module gate", () => {
  it("refuses a delegate assigned with an EMPTY permission map", async () => {
    linkRows = grant({ [PROPERTY]: {} });
    const result = await getShareablePropertyForUser(DELEGATE, PROPERTY);
    expect(result).toBeNull();
  });

  it("refuses a delegate granted `promotion` at READ only", async () => {
    linkRows = grant({ [PROPERTY]: { promotion: { read: true } } });
    const result = await getShareablePropertyForUser(DELEGATE, PROPERTY);
    expect(result).toBeNull();
  });

  it("refuses a delegate granted a DIFFERENT module", async () => {
    linkRows = grant({ [PROPERTY]: { properties: { read: true, edit: true } } });
    const result = await getShareablePropertyForUser(DELEGATE, PROPERTY);
    expect(result).toBeNull();
  });

  it("allows a delegate granted `promotion` at EDIT", async () => {
    linkRows = grant({ [PROPERTY]: { promotion: { read: true, edit: true } } });
    const result = await getShareablePropertyForUser(DELEGATE, PROPERTY);
    expect(result).toEqual(LIVE_PROPERTY);
  });

  it("still works for the direct owner with no link rows at all", async () => {
    linkRows = [];
    const result = await getShareablePropertyForUser(OWNER, PROPERTY);
    expect(result).toEqual(LIVE_PROPERTY);
  });

  it("still works for the link's own inviter when ownership has drifted (not a co-manager grant)", async () => {
    // The property's current manager_user_id no longer matches the link's
    // inviter (an ownership transfer happened), so the invitee-side module
    // check cannot pass — the inviter-fallback branch must still resolve.
    propertyRecord = { manager_user_id: DRIFTED_OWNER, status: "live", property_data: LIVE_PROPERTY };
    linkRows = [
      { inviter_user_id: OWNER, invitee_user_id: "someone-else", assigned_property_ids: [PROPERTY] },
    ];
    const result = await getShareablePropertyForUser(OWNER, PROPERTY);
    expect(result).toEqual(LIVE_PROPERTY);
  });

  it("refuses a non-live listing regardless of grant", async () => {
    propertyRecord = { manager_user_id: OWNER, status: "draft", property_data: LIVE_PROPERTY };
    linkRows = grant({ [PROPERTY]: { promotion: { read: true, edit: true } } });
    const result = await getShareablePropertyForUser(DELEGATE, PROPERTY);
    expect(result).toBeNull();
  });
});
