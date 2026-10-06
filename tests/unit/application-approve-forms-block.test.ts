/**
 * Approval waits for the forms that block it. A move-in form sent with "Blocks: Approval" and still
 * unsubmitted makes the server refuse the transition INTO `approved` (409, `blocked: "forms"`) on both
 * write paths the manager UI uses (the single-row upsert and the batch mirror) and on the resident-approval
 * route; once the resident submits, the same request goes through. An already-approved row stays editable.
 * A forms read that FAILS still refuses, but as a retryable 503 (`blocked: "forms-check"`) that names no
 * form — there may not be one, and the manager has nothing to chase.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null = null;
let STORED_ROWS: { id: string; row_data: DemoApplicantRow; manager_user_id?: string | null; resident_email?: string | null }[] = [];
let UPSERTS: { id: string; row_data: DemoApplicantRow }[] = [];
let FORMS: Array<Record<string, unknown>> = [];
let FORMS_ERROR: { code: string; message: string } | null = null;
const FORM_QUERIES: Array<{ column: string; values: unknown }> = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/provision-approved-resident", () => ({ provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

function makeDb() {
  return {
    from(table: string) {
      const state: { ids: string[] | null; eqManagerUserId: string | null } = { ids: null, eqManagerUserId: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: () => builder,
        insert: () => Promise.resolve({ error: null }),
        upsert(values: { id: string; row_data: DemoApplicantRow }) {
          if (table === "manager_application_records") UPSERTS.push(values);
          return Promise.resolve({ error: null });
        },
        delete: () => builder,
        eq(column: string, value: string) {
          if (column === "manager_user_id") state.eqManagerUserId = value;
          if (table === "resident_move_in_forms") FORM_QUERIES.push({ column, values: value });
          return builder;
        },
        ilike: () => builder,
        or: () => builder,
        neq: () => builder,
        in(column: string, values: string[]) {
          if (column === "id") state.ids = values;
          if (table === "resident_move_in_forms") FORM_QUERIES.push({ column, values });
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          if (table === "manager_application_records") {
            const hit = STORED_ROWS.find((r) => (state.ids ? state.ids.includes(r.id) : true));
            return Promise.resolve({ data: hit ?? null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          if (table === "resident_move_in_forms") {
            return Promise.resolve(FORMS_ERROR ? { data: null, error: FORMS_ERROR } : { data: FORMS, error: null }).then(resolve);
          }
          if (table === "manager_application_records") {
            let out = STORED_ROWS;
            if (state.ids) out = out.filter((r) => state.ids?.includes(r.id));
            if (state.eqManagerUserId) out = out.filter((r) => r.manager_user_id === state.eqManagerUserId);
            return Promise.resolve({ data: out, error: null }).then(resolve);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const OWNER = "mgr-owner";
const EMAIL = "manager@example.com";
const BLOCKING_FORM = { id: "form-1", form_id: "f1", status: "sent", sent_at: "2026-10-03T00:00:00Z", snapshot: { kind: "other", blocks: "approval" } };

function applicationRow(id: string, over: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id, name: id, email: `${id.toLowerCase()}@example.com`, property: "The Magnolia", propertyId: "prop-1", bucket: "pending", stage: "Submitted", detail: "",
    managerUserId: OWNER, application: { ...createInitialRentalWizardState(), propertyId: "prop-1", leaseStart: "2026-09-05" }, ...over,
  } as unknown as DemoApplicantRow;
}

async function call(action: "upsert" | "replace", row: DemoApplicantRow) {
  const { POST } = await import("@/app/api/manager-applications/route");
  const res = await POST(new Request("http://localhost/api/manager-applications", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(action === "upsert" ? { action, row } : { action, rows: [row] }),
  }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  PROFILE = { role: "manager", email: EMAIL };
  getUser.mockResolvedValue({ data: { user: { id: OWNER, email: EMAIL, user_metadata: {} } }, error: null });
  STORED_ROWS = [];
  UPSERTS = [];
  FORMS = [];
  FORMS_ERROR = null;
  FORM_QUERIES.length = 0;
});

describe.each(["upsert", "replace"] as const)("POST /api/manager-applications %s — approving while a form blocks approval", (action) => {
  it("answers 409 with blocked: forms and writes nothing while the form is unsubmitted", async () => {
    const pending = applicationRow("AXIS-GRACE");
    STORED_ROWS = [{ id: pending.id, row_data: pending, manager_user_id: OWNER, resident_email: pending.email }];
    FORMS = [BLOCKING_FORM];
    const res = await call(action, { ...pending, bucket: "approved" });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ blocked: "forms", error: expect.stringContaining("form") });
    expect(UPSERTS).toHaveLength(0);
    // Read from the forms table by the application's own id, never from the request.
    expect(FORM_QUERIES).toContainEqual({ column: "application_id", values: expect.arrayContaining(["AXIS-GRACE"]) });
  });

  it("goes through once the form is submitted (or blocks nothing)", async () => {
    const pending = applicationRow("AXIS-GRACE");
    STORED_ROWS = [{ id: pending.id, row_data: pending, manager_user_id: OWNER, resident_email: pending.email }];
    FORMS = [];
    expect((await call(action, { ...pending, bucket: "approved" })).status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });

  it("fails closed when the forms cannot be read, as a retryable 503 that names no form", async () => {
    const pending = applicationRow("AXIS-GRACE");
    STORED_ROWS = [{ id: pending.id, row_data: pending, manager_user_id: OWNER, resident_email: pending.email }];
    FORMS_ERROR = { code: "500", message: "boom" };
    const res = await call(action, { ...pending, bucket: "approved" });
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    // Never the form-block copy: there may be no form at all, so the manager is told to try again.
    expect(res.body).toMatchObject({ blocked: "forms-check", error: expect.stringContaining("try again") });
    expect(res.body.error).not.toContain("has to be submitted");
    expect(UPSERTS).toHaveLength(0);
  });

  it("only judges the transition into approved: an already-approved row stays editable, and declining is never blocked", async () => {
    FORMS = [BLOCKING_FORM];
    const approved = applicationRow("AXIS-AARON", { bucket: "approved" });
    STORED_ROWS = [{ id: approved.id, row_data: approved, manager_user_id: OWNER, resident_email: approved.email }];
    expect((await call(action, { ...approved, detail: "edited" })).status).toBe(200);
    const pending = applicationRow("AXIS-GRACE");
    STORED_ROWS = [{ id: pending.id, row_data: pending, manager_user_id: OWNER, resident_email: pending.email }];
    expect((await call(action, { ...pending, bucket: "rejected" })).status).toBe(200);
  });
});
