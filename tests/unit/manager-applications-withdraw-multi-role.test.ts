/**
 * Route-level regression: `POST /api/manager-applications` with
 * `{ action: "withdraw" }` for a MULTI-ROLE account.
 *
 * The bug: a person signed in as ogambik2@gmail.com — whose legacy
 * `profiles.role` is `manager`/`owner` because they also manage property —
 * opened THEIR OWN application from their resident portal list and got
 * "Only the applicant can withdraw this application." The list shows the row on
 * an EMAIL match, but the withdraw guard gated on `role === "resident"`; the two
 * disagreed about ownership. Ownership must be by email (the per-record gate),
 * not by active/primary portal role.
 *
 * This drives the real route handler end-to-end, mirroring the resident-submit
 * attribution test's Supabase stub.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null = null;
let STORED_ROWS: { id: string; row_data: DemoApplicantRow; resident_email?: string | null }[] = [];
let UPDATES: { id: string; row_data: DemoApplicantRow }[] = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

/** Chainable Supabase stub — only the surface the withdraw path touches. */
function makeDb() {
  return {
    from(table: string) {
      const state: { ids: string[] | null; eqId: string | null; update: DemoApplicantRow | null } = {
        ids: null,
        eqId: null,
        update: null,
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        update(values: { row_data: DemoApplicantRow }) {
          state.update = values.row_data;
          return builder;
        },
        insert: () => Promise.resolve({ error: null }),
        upsert: () => Promise.resolve({ error: null }),
        delete: () => builder,
        eq(column: string, value: string) {
          if (column === "id") {
            state.eqId = value;
            if (state.update && table === "manager_application_records") {
              UPDATES.push({ id: value, row_data: state.update });
            }
          }
          return builder;
        },
        ilike: () => builder,
        in(column: string, values: string[]) {
          if (column === "id") state.ids = values;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          if (table === "profile_roles") return Promise.resolve({ data: PROFILE ? [{ role: PROFILE.role }] : [], error: null }).then(resolve);
          if (table === "manager_application_records") {
            const rows = state.ids ? STORED_ROWS.filter((r) => state.ids?.includes(r.id)) : STORED_ROWS;
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const APPLICANT_EMAIL = "ogambik2@gmail.com";
const APP_ID = "PROPLANE-625089C2";

function storedRow(over: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: APP_ID,
    residentUserId: "multi-role-user-1",
    name: "ambika Mago",
    email: APPLICANT_EMAIL,
    property: "4709A 8th Ave NE",
    propertyId: "mgr-4709a-8th-1",
    stage: "Submitted",
    bucket: "pending",
    detail: "",
    ...over,
  };
}

async function withdraw(id: string) {
  const { POST } = await import("@/app/api/manager-applications/route");
  const res = await POST(
    new Request("http://localhost/api/manager-applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "withdraw", id }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The multi-role reality: this login manages property, so its legacy role is
  // `manager`/`owner`, but its EMAIL owns the application it is withdrawing.
  PROFILE = { role: "owner", email: APPLICANT_EMAIL };
  getUser.mockResolvedValue({
    data: { user: { id: "multi-role-user-1", email: APPLICANT_EMAIL, email_confirmed_at: "confirmed", user_metadata: {} } },
    error: null,
  });
  STORED_ROWS = [{ id: APP_ID, row_data: storedRow(), resident_email: APPLICANT_EMAIL }];
  UPDATES = [];
});

describe("POST /api/manager-applications — withdraw for a multi-role account", () => {
  it("lets a manager/owner-primary account withdraw its OWN application (email match)", async () => {
    const res = await withdraw(APP_ID);

    expect(res.status).toBe(200);
    expect(res.body.withdrawn).toBe(1);
    // The one-way `withdrawnAt` stamp was written to the row.
    expect(UPDATES).toHaveLength(1);
    expect(UPDATES[0].row_data.withdrawnAt).toBeTruthy();
  });

  it("still refuses withdrawing SOMEONE ELSE's application (email mismatch)", async () => {
    PROFILE = { role: "owner", email: "different-person@example.com" };
    getUser.mockResolvedValue({
      data: { user: { id: "other-user", email: "different-person@example.com", email_confirmed_at: "confirmed", user_metadata: {} } },
      error: null,
    });

    const res = await withdraw(APP_ID);

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/only withdraw your own/i);
    expect(UPDATES).toHaveLength(0);
  });

  it("refuses withdrawing an application that is no longer pending", async () => {
    STORED_ROWS = [{ id: APP_ID, row_data: storedRow({ bucket: "approved" }), resident_email: APPLICANT_EMAIL }];

    const res = await withdraw(APP_ID);

    expect(res.status).toBe(409);
    expect(UPDATES).toHaveLength(0);
  });
});
