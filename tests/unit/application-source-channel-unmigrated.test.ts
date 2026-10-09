import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `source_channel` only tags where the applicant came from. A database that has not had
 * `20261008180000_listing_lead_source.sql` applied yet must cost the lead tag, never the
 * application: PostgREST answers `PGRST204` and the write retries once without the column.
 *
 * The first thing the wizard writes is a DRAFT, which goes through `persistDraftRow` rather than
 * the plain upsert, so that is the path this covers.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  records: [] as Row[],
  user: null as { id: string; email?: string } | null,
  profile: null as Row | null,
  /** Writes that reached the fake table, in order, so a dropped column is visible. */
  writes: [] as { kind: "insert" | "update" | "upsert"; values: Row }[],
  /** Mirrors a table whose `source_channel` column does not exist yet. */
  rejectSourceChannel: true,
  /** The shape the database reports it with. */
  missingColumn: {} as { code: string; message: string; details: string | null },
}));

const PGRST_MISSING_COLUMN = {
  code: "PGRST204",
  message: "Could not find the 'source_channel' column of 'manager_application_records' in the schema cache",
  details: null,
};
/** Postgres with no usable message: only the preserved error CODE can identify this one. */
const BARE_MISSING_COLUMN = { code: "42703", message: "", details: null };

function readColumn(row: Row, col: string): unknown {
  const [base, key] = col.split("->>");
  if (!key) return row[col];
  const json = row[base] as Row | undefined;
  return json?.[key];
}

function makeFakeDb() {
  function builder(table: string) {
    const rows = table === "profiles" ? (state.profile ? [state.profile] : []) : state.records;
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "delete" | "update" = "select";
    let pending: Row | null = null;

    const matched = () => rows.filter((row) => filters.every((fn) => fn(row)));
    const refused = (values: Row) => state.rejectSourceChannel && Object.hasOwn(values, "source_channel");

    const api = {
      select() {
        if (mode === "update") {
          const values = pending as Row;
          state.writes.push({ kind: "update", values });
          if (refused(values)) return Promise.resolve({ data: null, error: { ...state.missingColumn } });
          const hit = matched();
          for (const row of hit) Object.assign(row, values);
          return Promise.resolve({ data: hit.map((row) => ({ id: row.id })), error: null });
        }
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((row) => readColumn(row, col) === val);
        return api;
      },
      neq(col: string, val: unknown) {
        filters.push((row) => readColumn(row, col) !== val);
        return api;
      },
      ilike(col: string, pattern: string) {
        const want = pattern.toLowerCase();
        filters.push((row) => String(readColumn(row, col) ?? "").toLowerCase() === want);
        return api;
      },
      is(col: string, val: unknown) {
        filters.push((row) => (val === null ? readColumn(row, col) == null : readColumn(row, col) === val));
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push((row) => vals.includes(readColumn(row, col)));
        return api;
      },
      or() {
        return api;
      },
      limit() {
        return Promise.resolve({ data: matched().slice(0, 1), error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: matched()[0] ?? null, error: null });
      },
      delete() {
        mode = "delete";
        return api;
      },
      update(values: Row) {
        mode = "update";
        pending = values;
        return api;
      },
      async insert(values: Row) {
        state.writes.push({ kind: "insert", values });
        if (refused(values)) return { data: null, error: { ...state.missingColumn } };
        if (state.records.some((row) => row.id === values.id)) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        state.records.push({ ...values });
        return { data: null, error: null };
      },
      async upsert(values: Row) {
        state.writes.push({ kind: "upsert", values });
        if (refused(values)) return { data: null, error: { ...state.missingColumn } };
        const idx = state.records.findIndex((row) => row.id === values.id);
        if (idx >= 0) state.records[idx] = { ...state.records[idx], ...values };
        else state.records.push({ ...values });
        return { data: null, error: null };
      },
      then(resolve: (value: { data: Row[]; count: number; error: null }) => unknown) {
        if (mode === "delete") {
          const doomed = new Set(matched());
          state.records = state.records.filter((row) => !doomed.has(row));
        }
        return Promise.resolve(resolve({ data: matched(), count: matched().length, error: null }));
      },
    };
    return api;
  }
  return { from: builder };
}

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeFakeDb() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/auth/link-resident-on-application-submit", () => ({
  linkResidentOnApplicationSubmit: async (_db: unknown, params: { row: Row }) => ({ ok: true, row: params.row }),
}));
vi.mock("@/lib/auth/provision-approved-resident", () => ({ provisionApprovedResidentAccount: async () => ({ ok: true }) }));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: async () => undefined }));
vi.mock("@/lib/rental-application/validate-application-submit.server", () => ({
  validateResidentApplicationRowForPersistence: async () => ({ ok: true }),
}));
vi.mock("@/lib/rental-application/application-fee-submit-guard.server", () => ({
  authorizeApplicationFeeSubmission: async () => ({ ok: true }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));

import { POST } from "@/app/api/manager-applications/route";

const AXIS_ID = "PROPLANE-SRC12345";
const RESIDENT_EMAIL = "applicant@test.com";

function applicationRow(stage: "Submitted" | "In progress"): Row {
  return {
    id: AXIS_ID,
    name: "Jane Applicant",
    property: "Willow House",
    propertyId: "prop-willow",
    managerUserId: "mgr-1",
    stage,
    bucket: "pending",
    backgroundCheckStatus: "pending_review",
    detail: stage === "Submitted" ? "Submitted now" : "Started now",
    email: RESIDENT_EMAIL,
    application: { propertyId: "prop-willow", email: RESIDENT_EMAIL },
  };
}

async function postUpsert(row: Row, cookie = "pl_src=craigslist") {
  return POST(
    new Request("http://localhost/api/manager-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ action: "upsert", row }),
    }),
  );
}

function stored(): Row | undefined {
  return state.records.find((r) => r.id === AXIS_ID);
}

describe("an un-migrated source_channel never costs the applicant their application", () => {
  beforeEach(() => {
    state.records = [];
    state.writes = [];
    state.user = { id: "resident-1", email: RESIDENT_EMAIL };
    state.profile = { id: "resident-1", email: RESIDENT_EMAIL, role: "resident" };
    state.rejectSourceChannel = true;
    state.missingColumn = PGRST_MISSING_COLUMN;
  });

  it("saves the first draft without the column when PostgREST has not seen it", async () => {
    const res = await postUpsert(applicationRow("In progress"));
    expect(res.status).toBe(200);
    expect(stored()).toBeTruthy();
    expect(stored()).not.toHaveProperty("source_channel");
    const inserts = state.writes.filter((w) => w.kind === "insert");
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.values).toHaveProperty("source_channel", "craigslist");
    expect(inserts[1]!.values).not.toHaveProperty("source_channel");
  });

  it("saves a submit without the column too", async () => {
    const res = await postUpsert(applicationRow("Submitted"));
    expect(res.status).toBe(200);
    expect(stored()).toBeTruthy();
    expect(stored()).not.toHaveProperty("source_channel");
  });

  it("tags the row once the column exists", async () => {
    state.rejectSourceChannel = false;
    expect((await postUpsert(applicationRow("In progress"))).status).toBe(200);
    expect(stored()).toHaveProperty("source_channel", "craigslist");
    expect(state.writes.filter((w) => w.kind === "insert")).toHaveLength(1);
  });

  it("retries on the bare Postgres code alone, which the draft path must carry through", async () => {
    state.missingColumn = BARE_MISSING_COLUMN;
    const res = await postUpsert(applicationRow("In progress"));
    expect(res.status).toBe(200);
    expect(stored()).toBeTruthy();
    expect(stored()).not.toHaveProperty("source_channel");
  });

  it("never tags an untagged request, so nothing is retried", async () => {
    expect((await postUpsert(applicationRow("In progress"), "")).status).toBe(200);
    expect(stored()).not.toHaveProperty("source_channel");
    expect(state.writes.filter((w) => w.kind === "insert")).toHaveLength(1);
  });
});
