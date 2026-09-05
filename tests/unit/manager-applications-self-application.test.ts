/**
 * Route-level coverage for the SELF-APPLICATION write path:
 * `POST /api/manager-applications` as a signed-in NON-resident (a manager who
 * "continued as guest" on the public apply page, or a multi-role login applying
 * somewhere they do not manage).
 *
 * Their autosave POST carries their session, so the route takes the
 * authenticated branch — and used to fall into the manager-edit gate, 403ing
 * every autosave of their OWN application to a listing they don't manage
 * (firing the "couldn't save" banner while persisting nothing). The write is
 * the applicant's own, keyed strictly on the authenticated email matching the
 * row's email and the application being pending — so a manager can never use
 * this path to write a DIFFERENT applicant's row, and editing someone else's
 * application still requires manager write access.
 *
 * Also covers `GET ?scope=self` — the email-scoped read the public apply flow
 * uses to resume a signed-in user's own draft regardless of their primary role.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null = null;
let PROPERTY_RECORDS: Record<string, { manager_user_id: string | null; status?: string | null; property_data: unknown }> = {};
let STORED_ROWS: { id: string; row_data: DemoApplicantRow; manager_user_id?: string | null; resident_email?: string | null }[] = [];
let UPSERTS: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }[] = [];
let INSERTS: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }[] = [];
let UPDATES: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }[] = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCoManagerPermissionForProperty: vi.fn(async () => false),
}));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedOwnerForProperty: vi.fn(async () => null),
  linkedPropertyIdsForModule: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

type WriteValues = { id: string; manager_user_id: string | null; row_data: DemoApplicantRow };

/** Chainable Supabase stub covering the select/update/insert/upsert shapes the route uses. */
function makeDb() {
  return {
    from(table: string) {
      const state: { op: "select" | "update" | "insert" | "upsert"; ids: string[] | null; eq: Record<string, string>; values: WriteValues | null } = {
        op: "select",
        ids: null,
        eq: {},
        values: null,
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        update(values: WriteValues) {
          state.op = "update";
          state.values = values;
          return builder;
        },
        insert(values: WriteValues) {
          if (table === "manager_application_records") INSERTS.push(values);
          return Promise.resolve({ error: null });
        },
        upsert(values: WriteValues) {
          if (table === "manager_application_records") UPSERTS.push(values);
          return Promise.resolve({ error: null });
        },
        delete: () => builder,
        eq(column: string, value: string) {
          state.eq[column] = value;
          return builder;
        },
        ilike: () => builder,
        is: () => builder,
        // The draft update's downgrade guard; `then()` below models the same
        // live-draft predicate, so the clause itself is a no-op here.
        or: () => builder,
        in(column: string, values: string[]) {
          if (column === "id") state.ids = values;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          if (table === "manager_property_records") {
            const id = state.eq["id"];
            return Promise.resolve({ data: (id && PROPERTY_RECORDS[id]) || null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          if (table !== "manager_application_records") {
            return Promise.resolve({ data: null, error: null }).then(resolve);
          }
          const matches = state.ids
            ? STORED_ROWS.filter((r) => state.ids?.includes(r.id))
            : state.eq["resident_email"]
              ? STORED_ROWS.filter((r) => (r.resident_email ?? r.row_data.email ?? "") === state.eq["resident_email"])
              : STORED_ROWS;
          if (state.op === "update") {
            // Conditional draft update: only a stored LIVE draft accepts it.
            const updatable = matches.filter(
              (r) => r.row_data.bucket === "pending" && r.row_data.stage.trim().toLowerCase() === "in progress" && !r.row_data.withdrawnAt,
            );
            if (updatable.length > 0 && state.values) UPDATES.push(state.values);
            return Promise.resolve({ data: updatable.map((r) => ({ id: r.id })), error: null }).then(resolve);
          }
          return Promise.resolve({ data: matches, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const LISTING_OWNER = "mgr-owner-of-the-listing";
const CALLER = "mgr-caller-applying-elsewhere";
const CALLER_EMAIL = "casey.manager@example.com";
const OTHER_APPLICANT_EMAIL = "someone.else@example.com";
const LISTING = "mgr-magnolia-2b-a1b2c3";

function inProgressRow(over: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "PROPLANE-SELFAPP1",
    name: "Casey Manager",
    email: CALLER_EMAIL,
    property: "The Magnolia · 2B",
    propertyId: LISTING,
    stage: "In progress",
    bucket: "pending",
    detail: "",
    ...over,
  };
}

async function upsert(row: DemoApplicantRow) {
  const { POST } = await import("@/app/api/manager-applications/route");
  const res = await POST(
    new Request("http://localhost/api/manager-applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ row }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  PROFILE = { role: "manager", email: CALLER_EMAIL };
  getUser.mockResolvedValue({
    data: { user: { id: CALLER, email: CALLER_EMAIL, user_metadata: {} } },
    error: null,
  });
  PROPERTY_RECORDS = { [LISTING]: { manager_user_id: LISTING_OWNER, status: "live", property_data: {} } };
  STORED_ROWS = [];
  UPSERTS = [];
  INSERTS = [];
  UPDATES = [];
});

describe("POST /api/manager-applications — self-application by a non-resident login", () => {
  it("persists the caller's OWN in-progress application to a listing they do not manage (no 403)", async () => {
    const res = await upsert(inProgressRow());

    expect(res.status).toBe(200);
    const persisted = INSERTS[0] ?? UPDATES[0];
    expect(persisted).toBeDefined();
    // Attribution comes from the LISTING, never the caller's manager identity.
    expect(persisted.manager_user_id).toBe(LISTING_OWNER);
    expect(persisted.row_data.managerUserId).toBe(LISTING_OWNER);
    expect(persisted.row_data.email).toBe(CALLER_EMAIL);
    expect(persisted.row_data.residentUserId).toBe(CALLER);
  });

  it("keeps autosaving after the row exists (the wizard's per-keystroke sync)", async () => {
    STORED_ROWS = [{ id: "PROPLANE-SELFAPP1", row_data: inProgressRow({ managerUserId: LISTING_OWNER }) }];
    const res = await upsert(inProgressRow({ detail: "edited" }));

    expect(res.status).toBe(200);
    expect(UPDATES).toHaveLength(1);
    expect(UPDATES[0].manager_user_id).toBe(LISTING_OWNER);
  });

  it("still gates a DIFFERENT applicant's row exactly as before (row email ≠ session email)", async () => {
    STORED_ROWS = [
      {
        id: "PROPLANE-VICTIM01",
        row_data: inProgressRow({ id: "PROPLANE-VICTIM01", email: OTHER_APPLICANT_EMAIL, managerUserId: LISTING_OWNER }),
        manager_user_id: LISTING_OWNER,
      },
    ];
    const res = await upsert(inProgressRow({ id: "PROPLANE-VICTIM01", email: OTHER_APPLICANT_EMAIL, detail: "tampered" }));

    expect(res.status).toBe(403);
    expect(INSERTS).toHaveLength(0);
    expect(UPDATES).toHaveLength(0);
    expect(UPSERTS).toHaveLength(0);
  });

  it("never lets the caller claim someone else's stored row by writing their own email onto it", async () => {
    STORED_ROWS = [
      {
        id: "PROPLANE-VICTIM02",
        row_data: inProgressRow({ id: "PROPLANE-VICTIM02", email: OTHER_APPLICANT_EMAIL, managerUserId: LISTING_OWNER }),
        manager_user_id: LISTING_OWNER,
      },
    ];
    // Incoming row carries the CALLER's email, but the stored row belongs to another applicant.
    const res = await upsert(inProgressRow({ id: "PROPLANE-VICTIM02" }));

    expect(res.status).toBe(403);
    expect(INSERTS).toHaveLength(0);
    expect(UPDATES).toHaveLength(0);
    expect(UPSERTS).toHaveLength(0);
  });

  it("never reopens a decided application through the self path", async () => {
    STORED_ROWS = [
      {
        id: "PROPLANE-SELFAPP1",
        row_data: inProgressRow({ bucket: "approved", stage: "Approved", managerUserId: LISTING_OWNER }),
        manager_user_id: LISTING_OWNER,
      },
    ];
    const res = await upsert(inProgressRow({ detail: "post-decision edit" }));

    expect(res.status).toBe(403);
    expect(INSERTS).toHaveLength(0);
    expect(UPDATES).toHaveLength(0);
    expect(UPSERTS).toHaveLength(0);
  });
});

describe("GET /api/manager-applications?scope=self", () => {
  it("returns the caller's OWN applicant rows by email, regardless of their manager role", async () => {
    STORED_ROWS = [
      { id: "PROPLANE-SELFAPP1", row_data: inProgressRow(), resident_email: CALLER_EMAIL },
      {
        id: "PROPLANE-VICTIM01",
        row_data: inProgressRow({ id: "PROPLANE-VICTIM01", email: OTHER_APPLICANT_EMAIL }),
        resident_email: OTHER_APPLICANT_EMAIL,
      },
    ];
    const { GET } = await import("@/app/api/manager-applications/route");
    const res = await GET(new Request("http://localhost/api/manager-applications?scope=self"));
    const body = (await res.json()) as { rows?: DemoApplicantRow[] };

    expect(res.status).toBe(200);
    expect(body.rows).toHaveLength(1);
    expect(body.rows?.[0]?.id).toBe("PROPLANE-SELFAPP1");
    expect(body.rows?.[0]?.email).toBe(CALLER_EMAIL);
  });

  it("excludes rows linked to another resident user id even when resident_email matches", async () => {
    STORED_ROWS = [
      {
        id: "PROPLANE-SELFAPP1",
        row_data: inProgressRow({ residentUserId: CALLER }),
        resident_email: CALLER_EMAIL,
      },
      {
        id: "PROPLANE-OTHERUSER",
        row_data: inProgressRow({
          id: "PROPLANE-OTHERUSER",
          residentUserId: "someone-else-user-id",
        }),
        resident_email: CALLER_EMAIL,
      },
    ];
    const { GET } = await import("@/app/api/manager-applications/route");
    const res = await GET(new Request("http://localhost/api/manager-applications?scope=self"));
    const body = (await res.json()) as { rows?: DemoApplicantRow[] };

    expect(res.status).toBe(200);
    expect(body.rows).toHaveLength(1);
    expect(body.rows?.[0]?.id).toBe("PROPLANE-SELFAPP1");
    expect(body.rows?.[0]?.residentUserId).toBe(CALLER);
  });
});

describe("GET /api/manager-applications resident email gate", () => {
  it("returns no rows when a resident has no profile or auth email", async () => {
    PROFILE = { role: "resident", email: "" };
    getUser.mockResolvedValue({
      data: { user: { id: "resident-no-email", user_metadata: {} } },
      error: null,
    });
    STORED_ROWS = [
      {
        id: "ORPHAN-APP",
        row_data: inProgressRow({ id: "ORPHAN-APP", email: "" }),
        resident_email: null,
      },
      {
        id: "OTHER-ORPHAN",
        row_data: inProgressRow({ id: "OTHER-ORPHAN", email: OTHER_APPLICANT_EMAIL }),
        resident_email: "",
      },
    ];
    const { GET } = await import("@/app/api/manager-applications/route");
    const res = await GET(new Request("http://localhost/api/manager-applications"));
    const body = (await res.json()) as { rows?: DemoApplicantRow[] };

    expect(res.status).toBe(200);
    expect(body.rows).toEqual([]);
  });
});
