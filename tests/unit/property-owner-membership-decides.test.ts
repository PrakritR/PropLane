/**
 * Round-3 review fixes: the owner MEMBERSHIP decides, not the legacy
 * `profiles.role` column and not a role default.
 *
 *  - a manager's reply is filed in the scope the owner Messages page reads,
 *    even for an owner whose account was created as a resident;
 *  - a membership that cannot be read withholds the manager surface at every
 *    call site instead of throwing into a page render;
 *  - a Property owner's flat grant is the keys the manager set, so a house
 *    that joins an "all houses" row later cannot resurrect the role default;
 *  - the number a manager texted a service link to is shown back to them.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyOwnerMessageInboxScope,
  loadOwnerGrantsOnce,
  managerMayMessageOwner,
  ownerMessagingRecipientIdsForManager,
  OWNER_MESSAGE_INBOX_SCOPE,
  withholdManagerSurface,
} from "@/lib/property-owner/access.server";
import { flatTeamRoleGrant } from "@/lib/co-manager-team-roles";
import { makeFakeDb } from "./property-owner-fake-db";

const MANAGER = "manager-1";
const OTHER_MANAGER = "manager-2";
const OWNER = "owner-1";
const HOUSE = "house-a";
const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";

const read = (p: string) => readFileSync(p, "utf8");

function ownerLinkRow(over: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    inviter_user_id: MANAGER,
    invitee_user_id: OWNER,
    status: "accepted",
    team_role: "property_owner",
    workspace_id: "ws-1",
    house_scope: "selected",
    assigned_property_ids: [HOUSE],
    property_co_manager_permissions: {
      [HOUSE]: { ownerPerformance: { read: true }, ownerMessages: { read: true } },
    },
    co_manager_permissions: {},
    ...over,
  };
}

/** An owner who signed up as a resident years ago: the legacy column still says so. */
function tables(over: Record<string, unknown>[] = [ownerLinkRow()]) {
  return {
    account_link_invites: over,
    profiles: [
      { id: OWNER, email: "dana@example.com", role: "resident" },
      { id: MANAGER, email: "manager@example.com", role: "manager" },
    ],
    manager_property_records: [{ id: HOUSE, manager_user_id: MANAGER, workspace_id: "ws-1" }],
  };
}

describe("the manager's reply lands where the owner reads", () => {
  it("re-scopes the owner's copy even though profiles.role says resident", async () => {
    const recipients = [
      { userId: OWNER, email: "dana@example.com", scope: RESIDENT_INBOX_SCOPE },
      { userId: "resident-9", email: "sam@example.com", scope: RESIDENT_INBOX_SCOPE },
    ];
    const out = await applyOwnerMessageInboxScope(makeFakeDb(tables()), { userId: MANAGER, role: "manager" }, recipients);
    expect(out.find((r) => r.userId === OWNER)!.scope).toBe(OWNER_MESSAGE_INBOX_SCOPE);
    // Every other recipient is untouched.
    expect(out.find((r) => r.userId === "resident-9")!.scope).toBe(RESIDENT_INBOX_SCOPE);
    expect(OWNER_MESSAGE_INBOX_SCOPE).toBe("axis_portal_inbox_manager_v1");
  });

  it("leaves the scope alone when Messages is off, for another manager, or for a non-manager sender", async () => {
    const recipients = [{ userId: OWNER, email: "dana@example.com", scope: RESIDENT_INBOX_SCOPE }];
    const messagesOff = tables([
      ownerLinkRow({
        property_co_manager_permissions: { [HOUSE]: { ownerPerformance: { read: true }, ownerMessages: { notification: false } } },
      }),
    ]);
    expect(
      (await applyOwnerMessageInboxScope(makeFakeDb(messagesOff), { userId: MANAGER, role: "manager" }, recipients))[0]!.scope,
    ).toBe(RESIDENT_INBOX_SCOPE);
    expect(
      (await applyOwnerMessageInboxScope(makeFakeDb(tables()), { userId: OTHER_MANAGER, role: "manager" }, recipients))[0]!.scope,
    ).toBe(RESIDENT_INBOX_SCOPE);
    expect(
      (await applyOwnerMessageInboxScope(makeFakeDb(tables()), { userId: MANAGER, role: "resident" }, recipients))[0]!.scope,
    ).toBe(RESIDENT_INBOX_SCOPE);
  });

  it("re-scopes for an admin-labelled sender too, because the scope belongs to the recipient", async () => {
    // The team dogfoods on multi-role accounts: the inviting manager of an
    // owner membership can be an account whose `profiles.role` is "admin".
    const recipients = [{ userId: OWNER, email: "dana@example.com", scope: RESIDENT_INBOX_SCOPE }];
    const out = await applyOwnerMessageInboxScope(makeFakeDb(tables()), { userId: MANAGER, role: "admin" }, recipients);
    expect(out[0]!.scope).toBe(OWNER_MESSAGE_INBOX_SCOPE);
  });

  it("asks the membership once per burst, not once per caller", async () => {
    const reads: Record<string, number> = {};
    const db = makeFakeDb(tables(), { reads });
    // What one send does: the recipient filter decides, then the re-scope does.
    expect(await managerMayMessageOwner(db, MANAGER, OWNER)).toBe(true);
    expect([...(await ownerMessagingRecipientIdsForManager(db, MANAGER, [OWNER]))]).toEqual([OWNER]);
    // `loadOwnerGrants` is 2 + one-per-link reads; memoized it runs once, and
    // the candidate list is one query however often it is asked.
    expect(reads.manager_property_records).toBe(1);
    expect(reads.account_link_invites).toBe(2);
    expect(await loadOwnerGrantsOnce(db, OWNER)).toHaveLength(1);
    expect(reads.manager_property_records).toBe(1);
    // A different client starts clean.
    const fresh: Record<string, number> = {};
    await managerMayMessageOwner(makeFakeDb(tables(), { reads: fresh }), MANAGER, OWNER);
    expect(fresh.manager_property_records).toBe(1);
  });

  it("names only the owners of this manager's own memberships", async () => {
    const db = makeFakeDb(tables());
    expect([...(await ownerMessagingRecipientIdsForManager(db, MANAGER, [OWNER, "resident-9"]))]).toEqual([OWNER]);
    expect([...(await ownerMessagingRecipientIdsForManager(db, OTHER_MANAGER, [OWNER]))]).toEqual([]);
    expect([...(await ownerMessagingRecipientIdsForManager(db, MANAGER, []))]).toEqual([]);
  });

  it("both send paths re-scope, and the owner reader uses the one shared constant", () => {
    for (const file of ["src/app/api/portal/send-inbox-message/route.ts", "src/lib/portal-inbox-delivery.ts"]) {
      expect(read(file), file).toContain("applyOwnerMessageInboxScope(db, {");
    }
    expect(read("src/lib/property-owner/messages.server.ts")).toContain("OWNER_MESSAGE_INBOX_SCOPE");
  });

  it("the owner's inbox read keeps the newest rows, not an arbitrary 200", () => {
    const src = read("src/lib/property-owner/messages.server.ts");
    expect(src).toMatch(/\.order\("created_at", \{ ascending: false \}\)\s*\n\s*\.limit\(200\)/);
  });
});

describe("a membership that cannot be read withholds the manager surface", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves a plain manager alone when the reads succeed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // A manager with no owner row at all: the overwhelmingly common case.
    expect(await withholdManagerSurface(makeFakeDb({ account_link_invites: [] }), MANAGER)).toBe(false);
    // ...and one with houses, a plan and a teammate seat of their own.
    const busy = makeFakeDb({
      account_link_invites: [{ id: "l", invitee_user_id: MANAGER, status: "accepted", team_role: "admin" }],
      manager_property_records: [{ id: HOUSE, manager_user_id: MANAGER }],
      manager_purchases: [{ id: "p", user_id: MANAGER }],
      profile_roles: [{ user_id: MANAGER, role: "manager" }],
      profiles: [{ id: MANAGER, email: "manager@example.com" }],
    });
    expect(await withholdManagerSurface(busy, MANAGER)).toBe(false);
    expect(logged).not.toHaveBeenCalled();
  });

  it("logs the denial so a membership outage is diagnosable", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = makeFakeDb({ account_link_invites: [] }, { errors: { account_link_invites: { message: "boom" } } });
    expect(await withholdManagerSurface(broken, MANAGER)).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
    const [message, payload] = logged.mock.calls[0] as [string, string];
    expect(message).toContain("owner_membership_unreadable");
    expect(JSON.parse(payload)).toMatchObject({ userId: MANAGER });
    expect(JSON.parse(payload).error).toContain("OwnerAccessUnavailableError");
  });

  it("withholdManagerSurface answers true for an unreadable membership and for an owner-only account", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = makeFakeDb({ account_link_invites: [] }, { errors: { account_link_invites: { message: "boom" } } });
    expect(await withholdManagerSurface(broken, MANAGER)).toBe(true);
    const owner = makeFakeDb({
      ...tables(),
      manager_property_records: [],
      manager_purchases: [],
      profile_roles: [{ user_id: OWNER, role: "manager" }],
    });
    expect(await withholdManagerSurface(owner, OWNER)).toBe(true);
    expect(await withholdManagerSurface(makeFakeDb({ account_link_invites: [] }), MANAGER)).toBe(false);
  });

  it("every manager-side call site goes through it, and the page shells show neither portal", () => {
    for (const file of [
      "src/lib/manager-route-guard.server.ts",
      "src/lib/reports/auth.ts",
      "src/lib/tools/context.ts",
      "src/lib/portal-inbox-thread-scope.ts",
    ]) {
      expect(read(file), file).toContain("withholdManagerSurface");
      expect(read(file), file).not.toContain(").ownerOnly");
    }
    for (const file of ["src/app/portal/layout.tsx", "src/lib/render-portal-section.tsx"]) {
      expect(read(file), file).toContain("<PortalAccessUnavailable />");
    }
    // The two that must tell 403 from 503 keep the explicit refusal.
    expect(read("src/app/api/portal-vendors/route.ts")).toContain("refuseOwnerOnly(db, user.id)");
    expect(read("src/lib/property-owner/page-guard.server.ts")).toContain("catch {");
  });
});

describe("a Property owner's flat grant is what the manager set", () => {
  it("is the link's own keys, never the role default", () => {
    const allOff = {
      [HOUSE]: {
        ownerPerformance: { notification: false },
        ownerStatements: { notification: false },
        ownerDocuments: { notification: false },
        ownerMessages: { notification: false },
      },
    };
    // "No access" stays EXPLICIT, so a house that joins an "all houses" row
    // later reads as off rather than as unset (which the role default fills).
    expect(flatTeamRoleGrant("property_owner", allOff)).toEqual({
      ownerPerformance: { notification: false },
      ownerStatements: { notification: false },
      ownerDocuments: { notification: false },
      ownerMessages: { notification: false },
    });
    const statementsOnly = {
      [HOUSE]: { ownerStatements: { read: true, notification: true }, ownerDocuments: { notification: false } },
    };
    expect(flatTeamRoleGrant("property_owner", statementsOnly)).toEqual({
      ownerStatements: { read: true, notification: true },
      ownerDocuments: { notification: false },
    });
    // On anywhere wins; a key nobody mentions stays unset.
    expect(
      flatTeamRoleGrant("property_owner", {
        "house-a": { ownerStatements: { notification: false } },
        "house-b": { ownerStatements: { read: true } },
      }),
    ).toEqual({ ownerStatements: { read: true, notification: true } });
    // A module grant can never ride along on an owner's flat column.
    expect(flatTeamRoleGrant("property_owner", { [HOUSE]: { financials: true, ownerStatements: { read: true } } })).toEqual({
      ownerStatements: { read: true, notification: true },
    });
    // Every other role still stamps, and Custom still falls back to the caller.
    expect(flatTeamRoleGrant("viewer", {})).toMatchObject({ properties: { read: true, notification: true } });
    expect(flatTeamRoleGrant("custom", {})).toBeNull();
    expect(flatTeamRoleGrant(null, {})).toBeNull();
  });

  it("all three write paths use it: invite, mint redeem and edit", () => {
    for (const file of [
      "src/app/api/pro/account-links/route.ts",
      "src/app/api/pro/account-links/[inviteId]/route.ts",
      "src/lib/invite-links/invite-links.server.ts",
    ]) {
      expect(read(file), file).toContain("flatTeamRoleGrant(");
    }
  });
});

describe("the texted service-link number is shown back to the manager", () => {
  it("the vendors list and the vendor record both render it while the row has no phone", () => {
    const list = read("src/components/portal/pro-vendors-panel.tsx");
    expect(list).toContain("`Texted to ${label}`");
    expect(list).toContain("vendorLinkPhoneFact(row)");
    expect(list).toMatch(/if \(row\.phone\?\.trim\(\)\) return undefined;/);
    const record = read("src/components/portal/pro-vendor-detail.tsx");
    expect(record).toContain('fact("Texted to"');
    expect(record).toContain("!draft.phone.trim()");
  });

  it("it is still never identity: no routing or sending path reads it", () => {
    for (const file of [
      "src/lib/sms/inbound-text-routing.server.ts",
      "src/lib/vendor-work-identity.server.ts",
      "src/lib/portal-inbox-delivery.ts",
    ]) {
      expect(read(file).includes("linkPhone"), file).toBe(false);
    }
  });
});

describe("the Statements house filter survives a failed filter", () => {
  it("the tab band renders above the loading / error / empty switch", () => {
    const src = read("src/components/owner/owner-statements.tsx");
    const band = src.indexOf("<OwnerBand");
    const branch = src.indexOf("{loading && !data ?");
    expect(band).toBeGreaterThan(-1);
    expect(band).toBeLessThan(branch);
    expect(src.indexOf("<OwnerError")).toBeGreaterThan(band);
  });
});
