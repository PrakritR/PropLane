import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A submitted application must never be reverted to an "In progress" draft.
 *
 * The wizard fires an UNAWAITED draft sync (`syncInProgressApplicationRow`) on
 * every form change, so one of those POSTs is routinely still in flight when
 * the submit POST lands. Both requests carry the same axis id and both return
 * 200, so whichever upsert reaches the table last wins. When the draft wins,
 * the manager never sees the application and the resident sees a draft — a
 * silent loss of the core apply flow.
 *
 * These run the real POST handler against an in-memory
 * `manager_application_records` fake, in the exact order that loses data.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  records: [] as Row[],
  user: null as { id: string; email?: string } | null,
  profile: null as Row | null,
  // Holds the FIRST write carrying this stage until the promise resolves, so a
  // request can be frozen mid-flight and made to commit last. Models one
  // request's write landing after another's without relying on timing.
  holdStage: null as string | null,
  holdUntil: null as Promise<void> | null,
}));

/** Reads a column, understanding PostgREST JSON paths like `row_data->>stage`. */
function readColumn(row: Row, col: string): unknown {
  const [base, key] = col.split("->>");
  if (!key) return row[col];
  const json = row[base] as Row | undefined;
  return json?.[key];
}

/**
 * One clause of a PostgREST `.or()` filter — `col.op.value`, optionally negated
 * as `col.not.op.value`. SQL three-valued logic matters here: `not ilike`
 * against a NULL column yields NULL, i.e. the row does NOT match, which is why
 * the draft update pairs `stage.is.null` with `stage.not.ilike.submitted`.
 */
function parseOrClause(raw: string): (row: Row) => boolean {
  const [col, ...rest] = raw.split(".");
  const negated = rest[0] === "not";
  if (negated) rest.shift();
  const op = rest.shift();
  const value = rest.join(".");
  return (row) => {
    const actual = readColumn(row, col);
    if (op === "is") return value === "null" ? actual == null : String(actual) === value;
    if (actual == null) return false; // NULL compares as unknown, never as a match
    const hit =
      op === "ilike"
        ? String(actual).toLowerCase() === value.toLowerCase()
        : String(actual) === value;
    return negated ? !hit : hit;
  };
}

function makeFakeDb() {
  function builder(table: string) {
    const rows = table === "profiles" ? (state.profile ? [state.profile] : []) : state.records;
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "delete" | "update" = "select";
    let pending: Row | null = null;

    const matched = () => rows.filter((row) => filters.every((fn) => fn(row)));

    // The database evaluates an UPDATE's WHERE clause against the newest
    // committed row, so a held write re-checks its condition on release.
    async function awaitHold(values: Row) {
      const stage = (values.row_data as Row | undefined)?.stage;
      if (!state.holdUntil || stage !== state.holdStage) return;
      const hold = state.holdUntil;
      state.holdUntil = null;
      await hold;
    }

    const api = {
      select() {
        if (mode === "update") {
          const values = pending as Row;
          return awaitHold(values).then(() => {
            const hit = matched();
            for (const row of hit) Object.assign(row, values);
            return { data: hit.map((row) => ({ id: row.id })), error: null };
          });
        }
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((row) => readColumn(row, col) === val);
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
      or(expr: string) {
        const clauses = expr.split(",").map(parseOrClause);
        filters.push((row) => clauses.some((fn) => fn(row)));
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
        await awaitHold(values);
        // `id` is the table's primary key, so a concurrent insert loses here.
        if (state.records.some((row) => row.id === values.id)) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        state.records.push({ ...values });
        return { data: null, error: null };
      },
      async upsert(values: Row) {
        await awaitHold(values);
        const idx = state.records.findIndex((row) => row.id === values.id);
        if (idx >= 0) state.records[idx] = { ...state.records[idx], ...values };
        else state.records.push({ ...values });
        return { data: null, error: null };
      },
      then(resolve: (value: { data: Row[]; error: null }) => unknown) {
        if (mode === "delete") {
          const doomed = new Set(matched());
          state.records = state.records.filter((row) => !doomed.has(row));
        }
        return Promise.resolve(resolve({ data: matched(), error: null }));
      },
    };
    return api;
  }
  return { from: builder };
}

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeFakeDb(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

vi.mock("@/lib/auth/link-resident-on-application-submit", () => ({
  linkResidentOnApplicationSubmit: async (_db: unknown, params: { row: Row }) => ({ ok: true, row: params.row }),
}));

vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: async () => ({ ok: true }),
}));

vi.mock("@/lib/screening/order-screening", () => ({
  tryAutoOrderScreening: async () => undefined,
}));

// Submit validation has dedicated route-level coverage. This suite isolates the
// persistence race and intentionally uses a compact application snapshot.
vi.mock("@/lib/rental-application/validate-application-submit.server", () => ({
  validateResidentApplicationRowForPersistence: async () => ({ ok: true }),
}));

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));

import { POST } from "@/app/api/manager-applications/route";

const AXIS_ID = "PROPLANE-GRP12345";
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
    application: { propertyId: "prop-willow", email: RESIDENT_EMAIL, groupId: "AXISGRP-TZNQYRN8" },
  };
}

async function postUpsert(row: Row) {
  const req = new Request("http://localhost/api/manager-applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "upsert", row }),
  });
  return POST(req);
}

function storedRow(): Row | undefined {
  return state.records.find((r) => r.id === AXIS_ID)?.row_data as Row | undefined;
}

describe("submitted applications survive a trailing in-progress draft write", () => {
  beforeEach(() => {
    state.records = [];
    state.user = { id: "resident-1", email: RESIDENT_EMAIL };
    state.profile = { id: "resident-1", email: RESIDENT_EMAIL, role: "resident" };
    state.holdStage = null;
    state.holdUntil = null;
  });

  it("keeps the submitted snapshot when a draft sync lands after submit", async () => {
    const submit = await postUpsert(applicationRow("Submitted"));
    expect(submit.status).toBe(200);
    expect(storedRow()?.stage).toBe("Submitted");

    // The draft POST the wizard fired before submit finally reaches the server.
    const trailingDraft = await postUpsert(applicationRow("In progress"));
    expect(trailingDraft.status).toBe(200);

    expect(storedRow()?.stage).toBe("Submitted");
    expect(storedRow()?.bucket).toBe("pending");
  });

  it("drops a concurrent draft write that saw the pre-submit state but commits last", async () => {
    // The losing interleaving: the draft request is already in flight and has
    // seen a table with no submitted row, then the submit lands, and only THEN
    // does the draft's write reach the table. A read-then-write guard passes its
    // check here and still clobbers the submission.
    let release!: () => void;
    state.holdStage = "In progress";
    state.holdUntil = new Promise<void>((resolve) => {
      release = resolve;
    });

    const draft = postUpsert(applicationRow("In progress"));
    const submit = await postUpsert(applicationRow("Submitted"));
    expect(submit.status).toBe(200);
    expect(storedRow()?.stage).toBe("Submitted");

    release();
    expect((await draft).status).toBe(200);

    expect(storedRow()?.stage).toBe("Submitted");
    expect(storedRow()?.detail).toBe("Submitted now");
    expect((storedRow()?.application as Row | undefined)?.groupId).toBe("AXISGRP-TZNQYRN8");
  });

  it("still lets a genuine draft resume write in progress before any submit", async () => {
    const first = await postUpsert(applicationRow("In progress"));
    expect(first.status).toBe(200);
    expect(storedRow()?.stage).toBe("In progress");

    const resumed = { ...applicationRow("In progress"), name: "Jane A. Applicant" };
    const second = await postUpsert(resumed);
    expect(second.status).toBe(200);
    expect(storedRow()?.stage).toBe("In progress");
    expect(storedRow()?.name).toBe("Jane A. Applicant");
  });

  it("a draft autosave landing after withdrawal never clears withdrawnAt", async () => {
    await postUpsert(applicationRow("In progress"));
    const stored = state.records.find((r) => r.id === AXIS_ID)!;
    stored.row_data = { ...(stored.row_data as Row), withdrawnAt: "2026-07-27T00:00:00.000Z" };

    // The debounced snapshot the wizard queued before the resident withdrew.
    const trailing = await postUpsert({ ...applicationRow("In progress"), detail: "Late autosave" });
    expect(trailing.status).toBe(200);

    expect(storedRow()?.withdrawnAt).toBe("2026-07-27T00:00:00.000Z");
    expect(storedRow()?.detail).toBe("Started now");
  });

  it("a resident upsert onto a submitted-but-withdrawn row keeps the withdrawal stamp", async () => {
    await postUpsert(applicationRow("Submitted"));
    const stored = state.records.find((r) => r.id === AXIS_ID)!;
    stored.row_data = { ...(stored.row_data as Row), withdrawnAt: "2026-07-27T00:00:00.000Z" };

    const res = await postUpsert({ ...applicationRow("Submitted"), detail: "Edited later" });
    expect(res.status).toBe(200);

    expect(storedRow()?.withdrawnAt).toBe("2026-07-27T00:00:00.000Z");
  });

  it("still lets the manager move a submitted application forward", async () => {
    await postUpsert(applicationRow("Submitted"));
    state.user = { id: "mgr-1", email: "mgr@test.com" };
    state.profile = { id: "mgr-1", email: "mgr@test.com", role: "manager" };

    const approved = { ...applicationRow("Submitted"), stage: "Approved", bucket: "approved" };
    const res = await postUpsert(approved);
    expect(res.status).toBe(200);
    expect(storedRow()?.stage).toBe("Approved");
  });
});
