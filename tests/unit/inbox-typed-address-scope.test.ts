import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/resident-subject-evidence.server", () => ({ residentSubjectManagerIds: async () => [] }));

import {
  filterRecipientsBySenderScope,
  isBareEmailAddress,
  managerMayMessageNewContacts,
} from "@/lib/inbox-recipient-scope";

type Row = Record<string, unknown>;
function makeDb(tables: Record<string, Row[]>) {
  function builder(table: string) {
    const rows = tables[table] ?? [];
    const filters: Array<(row: Row) => boolean> = [];
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => (filters.push((r) => String(r[col] ?? "") === String(val)), api),
      in: (col: string, vals: unknown[]) => {
        const set = new Set(vals.map(String));
        filters.push((r) => set.has(String(r[col] ?? "")));
        return api;
      },
      or: () => api,
      ilike: (col: string, val: string) => (filters.push((r) => String(r[col] ?? "").toLowerCase() === val.toLowerCase()), api),
      limit: () => api,
      maybeSingle: () => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(resolve),
    };
    return api;
  }
  return { from: (table: string) => builder(table) } as never;
}

const empty = () =>
  makeDb({
    manager_application_records: [],
    portal_household_charge_records: [],
    portal_lease_pipeline_records: [],
    portal_pro_relationship_records: [],
    account_link_invites: [],
    profiles: [],
  });

const manager = { id: "mgr_1", email: "mgr@example.com", role: "manager", isAdmin: false };
const resident = { id: "res_1", email: "res@example.com", role: "resident", isAdmin: false };

describe("typed address to a non-contact", () => {
  it("a manager with edit rights may email a bare typed address that is not yet a contact", async () => {
    const result = await filterRecipientsBySenderScope(empty(), manager, [{ email: "new.person@example.com", userId: null }], {
      allowTypedAddresses: true,
      confirmedAccountlessEmails: new Set(["new.person@example.com"]),
    });
    expect(result.allowed.map((r) => r.email)).toEqual(["new.person@example.com"]);
    expect(result.typedNewContacts).toEqual(["new.person@example.com"]);
  });

  it("an address the route did NOT confirm account-less (no set, empty set, other address) is refused", async () => {
    for (const confirmedAccountlessEmails of [undefined, new Set<string>(), new Set(["someone.else@example.com"])]) {
      const result = await filterRecipientsBySenderScope(empty(), manager, [{ email: "new.person@example.com", userId: null }], {
        allowTypedAddresses: true,
        confirmedAccountlessEmails,
      });
      expect(result.allowed).toEqual([]);
      expect(result.blocked).toHaveLength(1);
    }
  });

  it("without the route's edit-rights decision the same address is still refused", async () => {
    const result = await filterRecipientsBySenderScope(empty(), manager, [{ email: "new.person@example.com", userId: null }]);
    expect(result.allowed).toEqual([]);
    expect(result.blocked).toHaveLength(1);
  });

  it("a resident typing an email is still refused, even if the flag were passed", async () => {
    const result = await filterRecipientsBySenderScope(empty(), resident, [{ email: "new.person@example.com", userId: null }], {
      allowTypedAddresses: true,
    });
    expect(result.allowed).toEqual([]);
  });

  it("a vendor typing an email is still refused", async () => {
    const result = await filterRecipientsBySenderScope(
      empty(),
      { id: "ven_1", email: "v@example.com", role: "vendor", isAdmin: false },
      [{ email: "new.person@example.com", userId: null }],
      { allowTypedAddresses: true },
    );
    expect(result.allowed).toEqual([]);
  });

  it("a recipient userId outside the manager's scope is never authorized by the typed-address allowance", async () => {
    const result = await filterRecipientsBySenderScope(empty(), manager, [{ email: "stranger@example.com", userId: "user_9" }], {
      allowTypedAddresses: true,
      confirmedAccountlessEmails: new Set(["stranger@example.com"]),
    });
    expect(result.allowed).toEqual([]);
    expect(result.blocked).toHaveLength(1);
  });

  it("only bare, syntactically valid addresses pass", async () => {
    for (const bad of ["Name <a@example.com>", "a@example", "a b@example.com", "a@@example.com", "a@example.com\nbcc:x@y.com", ""]) {
      expect(isBareEmailAddress(bad), bad).toBe(false);
      const result = await filterRecipientsBySenderScope(empty(), manager, [{ email: bad, userId: null }], {
        allowTypedAddresses: true,
        confirmedAccountlessEmails: new Set([bad.trim().toLowerCase()]),
      });
      expect(result.allowed, bad).toEqual([]);
    }
    expect(isBareEmailAddress("first.last+tag@sub.example.com")).toBe(true);
  });
});

describe("managerMayMessageNewContacts", () => {
  const scope = (over: Record<string, unknown> = {}) => ({
    viewerId: "mgr_1",
    level: "edit",
    workspaceHouseIds: new Set(["house-1"]),
    grantedHousesByOwner: new Map<string, Set<string>>(),
    activeWorkspaceId: "ws-1",
    ...over,
  });
  const db = (owner: string) => makeDb({ portal_workspaces: [{ id: "ws-1", owner_user_id: owner }] });

  it("the workspace owner may", async () => {
    expect(await managerMayMessageNewContacts(db("mgr_1"), scope())).toBe(true);
  });

  it("a teammate with an edit grant on a house of the workspace may; a read-only seat (no grant) may not", async () => {
    expect(await managerMayMessageNewContacts(db("owner_x"), scope({ grantedHousesByOwner: new Map([["owner_x", new Set(["house-1"])]]) }))).toBe(true);
    expect(await managerMayMessageNewContacts(db("owner_x"), scope())).toBe(false);
    expect(await managerMayMessageNewContacts(db("owner_x"), scope({ grantedHousesByOwner: new Map([["owner_x", new Set(["house-elsewhere"])]]) }))).toBe(false);
  });

  it("fails closed: no workspace, a read-level scope, a closed scope or an unreadable workspace", async () => {
    expect(await managerMayMessageNewContacts(db("mgr_1"), scope({ activeWorkspaceId: null }))).toBe(false);
    expect(await managerMayMessageNewContacts(db("mgr_1"), scope({ level: "read" }))).toBe(false);
    expect(await managerMayMessageNewContacts(db("mgr_1"), scope({ closed: true }))).toBe(false);
    expect(await managerMayMessageNewContacts(makeDb({}), scope())).toBe(false);
  });
});
