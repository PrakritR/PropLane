/**
 * Evidence harness — the leasing pass's three application guarantees, driven through the REAL
 * `POST /api/manager-applications` against an in-memory `manager_application_records`:
 *
 *   1. ONE application per applicant per house: a second draft (new tab, new device, new client id)
 *      folds into the open one and the answer carries the kept id.
 *   2. An application the person never sent cannot be approved — single row and bulk, 409.
 *   3. The `application_started` text to the owner's alert phones is capped at 10 per owner per
 *      hour (the 2026-11-04 security fix), because a draft needs no session and picks its own id.
 *
 * Every id, status and text printed below came out of the route. With EVIDENCE_DIR set it writes
 * `application-draft-route.txt`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  records: [] as Row[],
  user: null as { id: string; email?: string; email_confirmed_at?: string } | null,
  profile: null as Row | null,
}));

const alerts = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

/** Reads a column, understanding PostgREST JSON paths like `row_data->>residentUserId`. */
function readColumn(row: Row, col: string): unknown {
  const [base, key] = col.split("->>");
  if (!key) return row[col];
  const json = row[base] as Row | undefined;
  return json?.[key];
}

function parseOrClause(raw: string): (row: Row) => boolean {
  const [col, ...rest] = raw.split(".");
  const negated = rest[0] === "not";
  if (negated) rest.shift();
  const op = rest.shift();
  const value = rest.join(".");
  return (row) => {
    const actual = readColumn(row, col);
    if (op === "is") return value === "null" ? actual == null : String(actual) === value;
    if (actual == null) return false;
    const hit = op === "ilike" ? String(actual).toLowerCase() === value.toLowerCase() : String(actual) === value;
    return negated ? !hit : hit;
  };
}

const HOUSE = "prop-ballard";
/** The owner of the one house. Each test picks its own so the per-owner hourly bucket starts empty. */
let OWNER = "mgr-ballard";

/** Every other table a best-effort write touches keeps its own array, so a notice insert never lands in the applications table. */
const sideTables = new Map<string, Row[]>();

function tableRows(table: string): Row[] {
  if (table === "manager_application_records") return state.records;
  if (table === "profiles") return state.profile ? [state.profile] : [];
  if (table === "profile_roles") return state.profile && state.user ? [{ user_id: state.user.id, role: state.profile.role }] : [];
  if (table === "manager_property_records") {
    return [{ id: HOUSE, manager_user_id: OWNER, status: "live", property_data: { buildingName: "Ballard House", managerUserId: OWNER } }];
  }
  let rows = sideTables.get(table);
  if (!rows) {
    rows = [];
    sideTables.set(table, rows);
  }
  return rows;
}

function makeFakeDb() {
  function builder(table: string) {
    const rows = tableRows(table);
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "delete" | "update" = "select";
    let pending: Row | null = null;
    const matched = () => rows.filter((row) => filters.every((fn) => fn(row)));

    const api: Record<string, unknown> = {
      select() {
        if (mode === "update") {
          const values = pending as Row;
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
      or(expr: string) {
        const clauses = expr.split(",").map(parseOrClause);
        filters.push((row) => clauses.some((fn) => fn(row)));
        return api;
      },
      order() {
        return api;
      },
      gte() {
        return api;
      },
      lte() {
        return api;
      },
      gt() {
        return api;
      },
      lt() {
        return api;
      },
      not() {
        return api;
      },
      single() {
        return Promise.resolve({ data: matched()[0] ?? null, error: null });
      },
      limit(n: number) {
        return Promise.resolve({ data: matched().slice(0, Math.max(1, n)), error: null });
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
      insert(values: Row) {
        const duplicate = values.id !== undefined && rows.some((row) => row.id === values.id);
        if (!duplicate) rows.push({ ...values });
        const result = duplicate
          ? { data: null, error: { code: "23505", message: "duplicate key value" } }
          : { data: [{ ...values }], error: null };
        // Chainable, like PostgREST: `.insert(...).select(...).maybeSingle()`.
        return Object.assign(Promise.resolve(result), {
          select: () => Object.assign(Promise.resolve(result), { maybeSingle: async () => ({ data: (result.data ?? [null])[0], error: result.error }), single: async () => ({ data: (result.data ?? [null])[0], error: result.error }) }),
        });
      },
      upsert(values: Row) {
        const idx = rows.findIndex((row) => row.id === values.id);
        if (idx >= 0) rows[idx] = { ...rows[idx], ...values };
        else rows.push({ ...values });
        const result = { data: [{ ...values }], error: null };
        return Object.assign(Promise.resolve(result), {
          select: () => Object.assign(Promise.resolve(result), { maybeSingle: async () => ({ data: result.data[0], error: null }), single: async () => ({ data: result.data[0], error: null }) }),
        });
      },
      then(resolve: (value: { data: Row[]; count: number; error: null }) => unknown) {
        if (mode === "delete") {
          const doomed = new Set(matched());
          for (let i = rows.length - 1; i >= 0; i -= 1) if (doomed.has(rows[i]!)) rows.splice(i, 1);
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
vi.mock("@/lib/auth/provision-approved-resident", () => ({ provisionApprovedResidentAccount: async () => ({ ok: true }) }));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: async () => undefined }));
vi.mock("@/lib/rental-application/validate-application-submit.server", () => ({
  memoizeEffectiveApplicationProperty: () => async () => ({ ok: true }),
  validateResidentApplicationRowForPersistence: async () => ({ ok: true }),
}));
vi.mock("@/lib/rental-application/application-fee-submit-guard.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/application-fee-submit-guard.server")>()),
  authorizeApplicationFeeSubmission: async () => ({ ok: true }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
// The transport leg of the owner alert: everything above it (the per-owner cap, the line text, the
// idempotency entity) is the real code under test.
vi.mock("@/lib/one-number/ops-alerts.server", () => ({
  alertPhonesOf: async (_db: unknown, input: Record<string, unknown>) => {
    alerts.calls.push(input);
    return { texted: 1, emailed: 0 };
  },
}));

import { UNSUBMITTED_APPROVAL_BLOCKED_MESSAGE } from "@/lib/rental-application/draft-shape";
import { POST } from "@/app/api/manager-applications/route";

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
const say = (line = "") => log.push(line);
afterAll(() => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/application-draft-route.txt`, `${log.join("\n")}\n`);
});

async function post(body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://localhost/api/manager-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const out = { status: res.status, body: (await res.json()) as Record<string, unknown> };
  await drainAfterResponse();
  return out;
}

/** `afterResponse` falls back to running the task now, unawaited, outside a request scope. */
async function drainAfterResponse() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function draft(id: string, email: string, name: string, answers: Record<string, unknown> = {}): Row {
  return {
    id,
    name,
    email,
    property: "Ballard House",
    propertyId: HOUSE,
    stage: "In progress",
    bucket: "pending",
    detail: "Started Nov 4",
    application: { propertyId: HOUSE, email, fullLegalName: name, ...answers },
  };
}

function storedDrafts(): Row[] {
  return state.records.map((r) => r.row_data as Row);
}

function asResident(id: string, email: string) {
  state.user = { id, email, email_confirmed_at: "confirmed" };
  state.profile = { id, email, role: "resident" };
}

beforeEach(() => {
  state.records = [];
  sideTables.clear();
  alerts.calls = [];
  asResident("resident-1", "kumar@example.com");
});

describe("one application per applicant per house", () => {
  beforeEach(() => {
    OWNER = "mgr-dedupe";
  });

  it("folds a second draft into the open one and answers with the kept id", async () => {
    say("=========================================================================");
    say("POST /api/manager-applications — one draft per applicant per house");
    say("=========================================================================");
    say();

    const first = await post({ action: "upsert", row: draft("PROPLANE-AAAA1111", "kumar@example.com", "Kumar", { currentStreet: "1 Market St" }) });
    say(`1. first draft  -> ${first.status} id=${String(first.body.id)}  rows in table: ${state.records.length}`);

    // A new tab picks a brand-new client id and knows nothing about the first draft.
    const second = await post({
      action: "upsert",
      row: draft("PROPLANE-BBBB2222", "kumar@example.com", "Kumar Selvam", { phone: "2065550123" }),
    });
    say(`2. second draft -> ${second.status} id=${String(second.body.id)}  rows in table: ${state.records.length}`);
    say();
    say(`   kept row: ${JSON.stringify({
      id: storedDrafts()[0]!.id,
      name: storedDrafts()[0]!.name,
      // Both drafts' answers are on the one row.
      street: (storedDrafts()[0]!.application as Row).currentStreet,
      phone: (storedDrafts()[0]!.application as Row).phone,
    })}`);
    say();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe("PROPLANE-AAAA1111");
    expect(state.records).toHaveLength(1);
    const kept = storedDrafts()[0]!;
    expect(kept.name).toBe("Kumar Selvam");
    expect((kept.application as Row).currentStreet).toBe("1 Market St");
    expect((kept.application as Row).phone).toBe("2065550123");
  });

  it("never walks a SENT application back to a draft: the kept id comes back marked submitted", async () => {
    await post({ action: "upsert", row: draft("PROPLANE-AAAA1111", "kumar@example.com", "Kumar") });
    const sent = state.records[0]!;
    sent.row_data = { ...(sent.row_data as Row), stage: "Submitted", detail: "Submitted Nov 4" };

    const late = await post({ action: "upsert", row: draft("PROPLANE-CCCC3333", "kumar@example.com", "Kumar") });
    say(`3. a draft for a house already applied to -> ${late.status} id=${String(late.body.id)} merged=${String(late.body.merged)}`);
    say(`   rows in table: ${state.records.length}, stage stays "${(storedDrafts()[0]! as Row).stage}"`);
    say();

    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ id: "PROPLANE-AAAA1111", merged: "submitted" });
    expect(state.records).toHaveLength(1);
    expect(storedDrafts()[0]!.stage).toBe("Submitted");
  });
});

describe("an application the person never sent cannot be approved", () => {
  beforeEach(async () => {
    OWNER = "mgr-approve";
    await post({ action: "upsert", row: draft("PROPLANE-AAAA1111", "kumar@example.com", "Kumar") });
    state.user = { id: OWNER, email: "owner@example.com", email_confirmed_at: "confirmed" };
    state.profile = { id: OWNER, email: "owner@example.com", role: "manager" };
  });

  it("refuses the single-row approve with the message the manager reads", async () => {
    const res = await post({
      action: "upsert",
      row: { ...draft("PROPLANE-AAAA1111", "kumar@example.com", "Kumar"), bucket: "approved", stage: "Approved", managerUserId: OWNER },
    });
    say("=========================================================================");
    say("Approving a draft the applicant never sent");
    say("=========================================================================");
    say();
    say(`4. manager approves an Incomplete row -> ${res.status} blocked=${String(res.body.blocked)}`);
    say(`   "${String(res.body.error)}"`);
    say(`   stored bucket is still "${storedDrafts()[0]!.bucket}" / stage "${storedDrafts()[0]!.stage}"`);
    say();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(UNSUBMITTED_APPROVAL_BLOCKED_MESSAGE);
    expect(res.body.blocked).toBe("draft");
    expect(storedDrafts()[0]!.bucket).toBe("pending");
    expect(storedDrafts()[0]!.stage).toBe("In progress");
  });

  it("refuses it in the manager panel's own bulk mirror too", async () => {
    const res = await post({
      action: "replace",
      rows: [{ ...draft("PROPLANE-AAAA1111", "kumar@example.com", "Kumar"), bucket: "approved", stage: "Approved", managerUserId: OWNER }],
    });
    say(`5. the same row through the panel's bulk mirror -> ${res.status} blockedDraftApprovals=${String(res.body.blockedDraftApprovals)}`);
    say(`   "${String(res.body.error)}"`);
    say();
    say();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(UNSUBMITTED_APPROVAL_BLOCKED_MESSAGE);
    expect(storedDrafts()[0]!.bucket).toBe("pending");
  });
});

describe("the application_started text is capped per owner per hour", () => {
  beforeEach(() => {
    OWNER = "mgr-cap";
  });

  it("texts the first ten named drafts and nothing after them", async () => {
    say("=========================================================================");
    say("application_started alerts — 12 applicants start a draft in one hour");
    say("=========================================================================");
    say();

    const NAMES = ["Asha Patel", "Ben Torres", "Chen Wu", "Dana Okafor", "Eli Rosen", "Farah Haddad", "Gus Lindqvist", "Hana Mori", "Ivan Petrov", "Jo Mwangi", "Kira Novak", "Liam O'Shea"];
    alerts.calls = [];
    for (let i = 1; i <= 12; i += 1) {
      const email = `applicant${i}@example.com`;
      asResident(`resident-${i}`, email);
      const res = await post({ action: "upsert", row: draft(`PROPLANE-DRAFT${String(i).padStart(4, "0")}`, email, NAMES[i - 1]!) });
      expect(res.status).toBe(200);
      await drainAfterResponse();
      const line = alerts.calls[alerts.calls.length - 1]?.text;
      say(`  draft ${String(i).padStart(2, " ")} -> ${alerts.calls.length <= 10 && alerts.calls.length === i ? `text: "${String(line)}"` : "no text (capped)"}`);
    }
    say();
    say(`  texts sent: ${alerts.calls.length} of 12 drafts; the cap is 10 per owner per hour.`);
    say(`  every text is keyed on its own application: ${new Set(alerts.calls.map((c) => c.entityId)).size} distinct entity ids.`);
    say();

    expect(alerts.calls).toHaveLength(10);
    expect(alerts.calls.every((call) => call.kind === "application_started" && call.ownerUserId === OWNER)).toBe(true);
    expect(alerts.calls[0]!.text).toBe("Application started — Asha P., Ballard House.");
    expect(new Set(alerts.calls.map((call) => call.entityId)).size).toBe(10);
  });

  it("a nameless first draft is not a start, and a later autosave never texts again", async () => {
    OWNER = "mgr-nameless";
    asResident("resident-99", "nameless@example.com");
    const nameless = draft("PROPLANE-EEEE9999", "nameless@example.com", "");
    delete (nameless.application as Row).fullLegalName;
    expect((await post({ action: "upsert", row: nameless })).status).toBe(200);
    await drainAfterResponse();
    say(`6. a step-1 draft with no name yet -> ${alerts.calls.length} texts`);
    expect(alerts.calls).toHaveLength(0);

    // The step that types the name is the one "start".
    expect((await post({ action: "upsert", row: draft("PROPLANE-EEEE9999", "nameless@example.com", "Nameless Applicant") })).status).toBe(200);
    await drainAfterResponse();
    say(`7. the step that types the name  -> ${alerts.calls.length} text: "${String(alerts.calls[0]?.text)}"`);

    expect((await post({ action: "upsert", row: draft("PROPLANE-EEEE9999", "nameless@example.com", "Nameless Applicant", { phone: "2065550000" }) })).status).toBe(200);
    await drainAfterResponse();
    say(`8. every later autosave          -> still ${alerts.calls.length} text`);
    say();
    expect(alerts.calls).toHaveLength(1);
  });
});
