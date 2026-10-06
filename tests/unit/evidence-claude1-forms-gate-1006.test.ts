/**
 * EVIDENCE HARNESS for the claude-1 lane's server-enforced Forms gating, which has no screen of its
 * own: a reviewer reads what the server actually ANSWERED (status + body) rather than a green tick.
 *
 * Covers the approval gate on both manager write paths (`upsert` and the batch `replace` mirror):
 *   - a form sent with "Blocks: Approval" and still unsubmitted refuses the move INTO `approved`
 *     with 409 `blocked: "forms"`, and writes nothing;
 *   - a forms read that FAILS still refuses, but fails CLOSED as a retryable 503
 *     `blocked: "forms-check"` that names no form;
 *   - once the form is submitted the same request goes through (200, one write);
 *   - the gate judges only the transition into `approved` — an approved row stays editable and a
 *     decline is never blocked.
 *
 * Same contract as the other evidence-* harnesses: plain assertions, and the transcript file is
 * written only when EVIDENCE_DIR asks for it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const transcript: string[] = [];
const say = (line: string) => transcript.push(line);
afterAll(() => {
  if (!EVIDENCE_DIR || transcript.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, "forms-approval-gate-transcript.txt"), `${transcript.join("\n")}\n`, "utf8");
});

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

describe.each(["upsert", "replace"] as const)(
  "POST /api/manager-applications %s — what the server answers while a form blocks approval",
  (action) => {
    it("refuses the move into approved with 409 blocked:forms and writes nothing", async () => {
      const pending = applicationRow("AXIS-GRACE");
      STORED_ROWS = [{ id: pending.id, row_data: pending, manager_user_id: OWNER, resident_email: pending.email }];
      FORMS = [BLOCKING_FORM];
      const res = await call(action, { ...pending, bucket: "approved" });
      say(`\n--- ${action}: approve AXIS-GRACE while "Approval questionnaire" is still unsubmitted ---`);
      say(`POST /api/manager-applications { action: "${action}", bucket: "approved" }`);
      say(`HTTP ${res.status} ${JSON.stringify(res.body)}`);
      say(`rows written: ${UPSERTS.length}`);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ blocked: "forms" });
      expect(UPSERTS).toHaveLength(0);
    });

    it("fails CLOSED on an unreadable forms table: retryable 503 blocked:forms-check naming no form", async () => {
      const pending = applicationRow("AXIS-GRACE");
      STORED_ROWS = [{ id: pending.id, row_data: pending, manager_user_id: OWNER, resident_email: pending.email }];
      FORMS_ERROR = { code: "500", message: "boom" };
      const res = await call(action, { ...pending, bucket: "approved" });
      say(`\n--- ${action}: the forms table cannot be read ---`);
      say(`POST /api/manager-applications { action: "${action}", bucket: "approved" }`);
      say(`HTTP ${res.status} ${JSON.stringify(res.body)}`);
      say(`rows written: ${UPSERTS.length}`);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ blocked: "forms-check" });
      expect(String(res.body.error)).not.toContain("has to be submitted");
      expect(UPSERTS).toHaveLength(0);
    });

    it("lets the same request through once the resident has submitted", async () => {
      const pending = applicationRow("AXIS-GRACE");
      STORED_ROWS = [{ id: pending.id, row_data: pending, manager_user_id: OWNER, resident_email: pending.email }];
      FORMS = [];
      const res = await call(action, { ...pending, bucket: "approved" });
      say(`\n--- ${action}: the blocking form has been submitted ---`);
      say(`POST /api/manager-applications { action: "${action}", bucket: "approved" }`);
      say(`HTTP ${res.status} ${JSON.stringify(res.body)}`);
      say(`rows written: ${UPSERTS.length}`);
      expect(res.status).toBe(200);
      expect(UPSERTS).toHaveLength(1);
    });

    it("judges only the transition into approved: an approved row stays editable, a decline is never blocked", async () => {
      FORMS = [BLOCKING_FORM];
      const approved = applicationRow("AXIS-AARON", { bucket: "approved" });
      STORED_ROWS = [{ id: approved.id, row_data: approved, manager_user_id: OWNER, resident_email: approved.email }];
      const edit = await call(action, { ...approved, detail: "edited" });
      const pending = applicationRow("AXIS-GRACE");
      STORED_ROWS = [{ id: pending.id, row_data: pending, manager_user_id: OWNER, resident_email: pending.email }];
      const decline = await call(action, { ...pending, bucket: "rejected" });
      say(`\n--- ${action}: the gate is only the transition INTO approved ---`);
      say(`edit an already-approved row  -> HTTP ${edit.status}`);
      say(`decline a pending row         -> HTTP ${decline.status}`);
      expect(edit.status).toBe(200);
      expect(decline.status).toBe(200);
    });
  },
);
