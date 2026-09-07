import { describe, expect, it } from "vitest";
import { filterRecipientsBySenderScope, listEligibleInboxContacts } from "@/lib/inbox-recipient-scope";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

/**
 * In-memory stand-in for the Supabase service client covering exactly the query
 * shapes filterRecipientsBySenderScope + managerOwnsResident use:
 *   from(table).select(cols).eq(col, val)                     -> await -> { data }
 *   from(table).select(cols).in(col, arr)                     -> await -> { data }
 *   from(table).select(cols).in(col, arr).eq(col, val).limit  -> await -> { data }
 *   from(table).select(cols).in(col, arr).or(expr).limit      -> await -> { data }
 */
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function makeDb(tables: Tables) {
  const rowsFor = (table: string) => tables[table] ?? [];

  function builder(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push((row) => String(row[col] ?? "") === String(val));
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        const set = new Set(vals.map((v) => String(v)));
        filters.push((row) => set.has(String(row[col] ?? "")));
        return api;
      },
      or: (expr: string) => {
        // Supports "col.eq.val,col2.eq.val2" used by managerOwnsResident / funnel checks.
        const clauses = String(expr)
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const match = /^([^.]+)\.eq\.(.+)$/.exec(part);
            if (!match) return null;
            return { col: match[1], val: match[2] };
          })
          .filter((item): item is { col: string; val: string } => Boolean(item));
        if (clauses.length > 0) {
          filters.push((row) =>
            clauses.some((clause) => String(row[clause.col] ?? "") === clause.val),
          );
        }
        return api;
      },
      ilike: (col: string, val: string) => {
        filters.push((row) => String(row[col] ?? "").toLowerCase() === String(val).toLowerCase());
        return api;
      },
      limit: () => api,
      maybeSingle: () => {
        const data = rowsFor(table).filter((row) => filters.every((f) => f(row)))[0] ?? null;
        return Promise.resolve({ data, error: null });
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => {
        const data = rowsFor(table).filter((row) => filters.every((f) => f(row)));
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return api;
  }

  return { from: (table: string) => builder(table) } as never;
}

const ADMIN = PRIMARY_ADMIN_EMAIL;

describe("filterRecipientsBySenderScope", () => {
  it("admin sender is unrestricted", async () => {
    const db = makeDb({});
    const { allowed, blocked } = await filterRecipientsBySenderScope(
      db,
      { id: "admin_1", email: "admin@axis.local", role: "admin", isAdmin: true },
      [{ email: "anyone@example.com", userId: "x" }],
    );
    expect(allowed).toHaveLength(1);
    expect(blocked).toHaveLength(0);
  });

  it("manager may message their own resident but not an arbitrary one", async () => {
    const db = makeDb({
      manager_application_records: [
        { manager_user_id: "mgr_1", resident_email: "mine@example.com", row_data: { bucket: "approved" } },
      ],
      portal_household_charge_records: [],
      portal_lease_pipeline_records: [],
      portal_pro_relationship_records: [],
    });
    const sender = { id: "mgr_1", email: "mgr@example.com", role: "manager", isAdmin: false };

    const own = await filterRecipientsBySenderScope(db, sender, [{ email: "mine@example.com", userId: null }]);
    expect(own.allowed.map((r) => r.email)).toEqual(["mine@example.com"]);

    const stranger = await filterRecipientsBySenderScope(db, sender, [{ email: "stranger@example.com", userId: null }]);
    expect(stranger.allowed).toHaveLength(0);
    expect(stranger.blocked).toHaveLength(1);
  });

  it("manager may message a linked co-manager and Axis admin", async () => {
    const db = makeDb({
      manager_application_records: [],
      portal_household_charge_records: [],
      portal_lease_pipeline_records: [],
      // Co-managers resolve from the authoritative account_link_invites, not the
      // client-writable relationship mirror.
      account_link_invites: [{ inviter_user_id: "mgr_1", invitee_user_id: "mgr_2", status: "accepted" }],
      profiles: [{ id: "mgr_2", email: "partner@example.com" }],
    });
    const sender = { id: "mgr_1", email: "mgr@example.com", role: "manager", isAdmin: false };

    const res = await filterRecipientsBySenderScope(db, sender, [
      { email: "partner@example.com", userId: "mgr_2" },
      { email: ADMIN, userId: null },
      { email: "random-manager@example.com", userId: "mgr_9" },
    ]);
    expect(res.allowed.map((r) => r.email).sort()).toEqual([ADMIN, "partner@example.com"].sort());
    expect(res.blocked.map((r) => r.email)).toEqual(["random-manager@example.com"]);
  });

  it("resident may message their manager, co-manager, housemate, and admin — not arbitrary people", async () => {
    const db = makeDb({
      manager_application_records: [
        {
          manager_user_id: "mgr_1",
          resident_email: "me@example.com",
          row_data: { bucket: "approved", assignedPropertyId: "prop_1", name: "Me" },
        },
        {
          manager_user_id: "mgr_1",
          resident_email: "housemate@example.com",
          row_data: { bucket: "approved", assignedPropertyId: "prop_1", name: "Housemate" },
        },
        {
          manager_user_id: "mgr_1",
          resident_email: "other-building@example.com",
          row_data: { bucket: "approved", assignedPropertyId: "prop_2", name: "Other" },
        },
      ],
      portal_household_charge_records: [],
      portal_lease_pipeline_records: [],
      account_link_invites: [{ inviter_user_id: "mgr_1", invitee_user_id: "mgr_2", status: "accepted" }],
      profiles: [
        { id: "mgr_1", email: "mymanager@example.com" },
        { id: "mgr_2", email: "co@example.com" },
      ],
    });
    const sender = { id: "res_1", email: "me@example.com", role: "resident", isAdmin: false };

    const res = await filterRecipientsBySenderScope(db, sender, [
      { email: "mymanager@example.com", userId: "mgr_1" },
      { email: "co@example.com", userId: "mgr_2" },
      { email: ADMIN, userId: null },
      { email: "housemate@example.com", userId: "res_2" },
      { email: "other-building@example.com", userId: "res_3" },
      { email: "unrelated-manager@example.com", userId: "mgr_9" },
    ]);
    expect(res.allowed.map((r) => r.email).sort()).toEqual(
      ["mymanager@example.com", "co@example.com", ADMIN, "housemate@example.com"].sort(),
    );
    expect(res.blocked.map((r) => r.email).sort()).toEqual(
      ["other-building@example.com", "unrelated-manager@example.com"].sort(),
    );
  });

  it("resident with no manager relationship can still reach Axis admin only", async () => {
    const db = makeDb({
      manager_application_records: [],
      portal_household_charge_records: [],
      portal_lease_pipeline_records: [],
      portal_pro_relationship_records: [],
      profiles: [],
    });
    const sender = { id: "res_1", email: "me@example.com", role: "resident", isAdmin: false };
    const res = await filterRecipientsBySenderScope(db, sender, [
      { email: ADMIN, userId: null },
      { email: "someone@example.com", userId: "u2" },
    ]);
    expect(res.allowed.map((r) => r.email)).toEqual([ADMIN]);
    expect(res.blocked.map((r) => r.email)).toEqual(["someone@example.com"]);
  });

  it("lets a resident message the manager connected by their booked tour", async () => {
    const db = makeDb({
      manager_application_records: [],
      portal_household_charge_records: [],
      portal_lease_pipeline_records: [],
      resident_tour_links: [{ resident_user_id: "res_1", manager_user_id: "mgr_tour" }],
      profiles: [{ id: "mgr_tour", email: "tour-manager@example.com", full_name: "Tour Manager" }],
      portal_pro_relationship_records: [],
      account_link_invites: [],
    });
    const sender = { id: "res_1", email: "prospect@example.com", role: "resident", isAdmin: false };

    const scoped = await filterRecipientsBySenderScope(db, sender, [
      { email: "tour-manager@example.com", userId: "mgr_tour" },
      { email: "unrelated@example.com", userId: "mgr_other" },
    ]);
    expect(scoped.allowed.map((row) => row.email)).toEqual(["tour-manager@example.com"]);
    expect(scoped.blocked.map((row) => row.email)).toEqual(["unrelated@example.com"]);

    const contacts = await listEligibleInboxContacts(db, sender);
    expect(contacts).toEqual([
      expect.objectContaining({ email: "tour-manager@example.com", role: "manager" }),
    ]);
  });

  it("lets a manager message a tour-only prospect and a listing-lead prospect, but not a stranger (PRP-424)", async () => {
    const db = makeDb({
      manager_application_records: [],
      portal_household_charge_records: [],
      portal_lease_pipeline_records: [],
      portal_pro_relationship_records: [],
      account_link_invites: [],
      resident_tour_links: [
        {
          id: "link_1",
          manager_user_id: "mgr_1",
          resident_user_id: "res_tour",
          attendee_email: "tour-only@example.com",
          property_id: "prop_1",
        },
      ],
      portal_inbox_thread_records: [
        {
          id: "thread_1",
          owner_user_id: "mgr_1",
          participant_email: "lead-only@example.com",
          row_data: { from: "Lead Guest", propertyTitle: "4534 Darrow", propertyId: "prop_2" },
        },
      ],
      portal_schedule_records: [
        {
          id: "axis_admin_partner_inquiries_v1",
          row_data: {
            payload: [
              { id: "inq_1", email: "inquiry-only@example.com", managerUserId: "mgr_1" },
              { id: "inq_other", email: "other-mgr-guest@example.com", managerUserId: "mgr_other" },
            ],
          },
        },
      ],
    });
    const sender = { id: "mgr_1", email: "mgr@example.com", role: "manager", isAdmin: false };

    const scoped = await filterRecipientsBySenderScope(db, sender, [
      { email: "tour-only@example.com", userId: "res_tour" },
      { email: "lead-only@example.com", userId: null },
      { email: "inquiry-only@example.com", userId: null },
      { email: "other-mgr-guest@example.com", userId: null },
      { email: "stranger@example.com", userId: null },
    ]);
    expect(scoped.allowed.map((row) => row.email).sort()).toEqual(
      ["inquiry-only@example.com", "lead-only@example.com", "tour-only@example.com"].sort(),
    );
    expect(scoped.blocked.map((row) => row.email).sort()).toEqual(
      ["other-mgr-guest@example.com", "stranger@example.com"].sort(),
    );

    const contacts = await listEligibleInboxContacts(db, sender);
    expect(contacts.map((c) => c.email).sort()).toEqual(
      ["lead-only@example.com", "tour-only@example.com"].sort(),
    );
  });
});
