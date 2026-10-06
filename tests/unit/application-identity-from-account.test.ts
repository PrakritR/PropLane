import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import {
  STANDARD_APPLICATION_FIELD_CATALOG,
} from "@/lib/rental-application/application-field-catalog";
import { validateRentalWizardStep } from "@/lib/rental-application/validate";
import {
  applyApplicantIdentityToRow,
  resolveApplicantIdentity,
} from "@/lib/rental-application/applicant-identity";
import type { DemoApplicantRow } from "@/data/demo-portal";

/**
 * Every application question is removable, including "Full legal name" and "Email". A template without them
 * still records WHO applied: the applicant's signed-in ACCOUNT supplies the name and email (never the body).
 */

describe("resolveApplicantIdentity", () => {
  it("takes the account's email whenever the answer is missing, lower-cased", () => {
    const id = resolveApplicantIdentity({ answers: {}, authUser: { email: "Jane.Doe@Example.com" } });
    expect(id.email).toBe("jane.doe@example.com");
    expect(id.emailSource).toBe("account");
    expect(id.emailMismatch).toBe(false);
  });

  it("never lets a body-supplied email override the authenticated one", () => {
    const id = resolveApplicantIdentity({
      answers: { email: "mallory@evil.test" },
      authUser: { email: "jane@example.com" },
    });
    expect(id.email).toBe("jane@example.com");
    expect(id.emailMismatch).toBe(true);
  });

  it("uses the answered email only for a signed-out applicant", () => {
    const id = resolveApplicantIdentity({ answers: { email: "Guest@Example.com" }, authUser: null });
    expect(id).toMatchObject({ email: "guest@example.com", emailSource: "answer" });
  });

  it("name: answer, then profile, then auth metadata, then the email's local part", () => {
    const authUser = { email: "jane.doe@example.com", user_metadata: { full_name: "Jane Metadata" } };
    expect(resolveApplicantIdentity({ answers: { fullLegalName: "Jane Answer" }, authUser, profile: { full_name: "Jane Profile" } }).name).toBe("Jane Answer");
    expect(resolveApplicantIdentity({ answers: {}, authUser, profile: { full_name: "Jane Profile" } })).toMatchObject({ name: "Jane Profile", nameSource: "profile" });
    expect(resolveApplicantIdentity({ answers: {}, authUser, profile: { full_name: "  " } })).toMatchObject({ name: "Jane Metadata", nameSource: "metadata" });
    expect(resolveApplicantIdentity({ answers: {}, authUser: { email: "jane.doe@example.com", user_metadata: { name: "Jane Name" } } }).name).toBe("Jane Name");
    expect(resolveApplicantIdentity({ answers: {}, authUser: { email: "jane.doe@example.com" } })).toMatchObject({ name: "jane.doe", nameSource: "email" });
  });

  it("treats the stored placeholder name as missing", () => {
    expect(resolveApplicantIdentity({ answers: { fullLegalName: "Applicant" }, authUser: { email: "a@b.co" }, profile: { full_name: "Real Person" } }).name).toBe("Real Person");
  });
});

describe("applyApplicantIdentityToRow", () => {
  const identity = resolveApplicantIdentity({ answers: {}, authUser: { email: "jane@example.com" }, profile: { full_name: "Jane Account" } });
  const base = { id: "AXIS-1", name: "", bucket: "pending", stage: "Submitted", application: { propertyId: "p1", fullLegalName: "", email: "" } } as unknown as DemoApplicantRow;

  it("a submitted row gets name, email and both answers from the account", () => {
    const row = applyApplicantIdentityToRow({ ...base, email: "" }, identity, { submitted: true });
    expect(row).toMatchObject({ name: "Jane Account", email: "jane@example.com" });
    expect(row.application).toMatchObject({ fullLegalName: "Jane Account", email: "jane@example.com" });
  });

  it("a draft gets only the row email: no name, no answers", () => {
    const row = applyApplicantIdentityToRow({ ...base, email: "" }, identity, { submitted: false });
    expect(row.email).toBe("jane@example.com");
    expect(row.name).toBe("");
    expect(row.application).toMatchObject({ fullLegalName: "", email: "" });
  });

  it("returns the same row, untouched, when the questions were answered", () => {
    const answered = { ...base, name: "Jane Answered", email: "jane@example.com", application: { propertyId: "p1", fullLegalName: "Jane Answered", email: "jane@example.com" } } as unknown as DemoApplicantRow;
    expect(applyApplicantIdentityToRow(answered, identity, { submitted: true })).toBe(answered);
  });
});

describe("the wizard validator no longer requires name or email once the template drops them", () => {
  const keyFor = (label: string) =>
    STANDARD_APPLICATION_FIELD_CATALOG.find((f) => f.section === "personal" && f.label === label)!.standardKey;
  const sub = (disabled: string[]) =>
    ({ v: 1, disabledStandardApplicationKeys: disabled, customApplicationFields: [] }) as never;
  const identityStep = (disabled: string[]) =>
    validateRentalWizardStep(2, createInitialRentalWizardState(), { property: { id: "p1", listingSubmission: sub(disabled) } as never });

  it("asks for both while the questions are on, and for neither once they are removed", () => {
    expect(identityStep([])).toMatchObject({ fullLegalName: expect.any(String), email: expect.any(String) });
    const errors = identityStep([keyFor("Full legal name"), keyFor("Email"), keyFor("Phone")]);
    expect(errors.fullLegalName).toBeUndefined();
    expect(errors.email).toBeUndefined();
    expect(errors.phone).toBeUndefined();
  });
});

// ---- the real POST /api/manager-applications handler over an in-memory fake -------------------------------------

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  records: [] as Row[],
  user: null as { id: string; email?: string; user_metadata?: Record<string, unknown> } | null,
  profile: null as Row | null,
}));

function makeFakeDb() {
  function builder(table: string) {
    const rows = table === "profiles" ? (state.profile ? [state.profile] : []) : state.records;
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "delete" | "update" = "select";
    let pending: Row | null = null;
    const matched = () => rows.filter((row) => filters.every((fn) => fn(row)));
    const api = {
      select() {
        if (mode === "update") {
          const hit = matched();
          for (const row of hit) Object.assign(row, pending);
          return Promise.resolve({ data: hit.map((row) => ({ id: row.id })), error: null });
        }
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((row) => row[col] === val);
        return api;
      },
      neq(col: string, val: unknown) {
        filters.push((row) => row[col] !== val);
        return api;
      },
      ilike(col: string, pattern: string) {
        filters.push((row) => String(row[col] ?? "").toLowerCase() === pattern.toLowerCase());
        return api;
      },
      is(col: string, val: unknown) {
        filters.push((row) => (val === null ? row[col] == null : row[col] === val));
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push((row) => vals.includes(row[col]));
        return api;
      },
      or() {
        return api;
      },
      order() {
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
        state.records.push({ ...values });
        return { data: null, error: null };
      },
      async upsert(values: Row) {
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
// Submit validation (including "a template without these questions asks for neither") has its own coverage above.
vi.mock("@/lib/rental-application/validate-application-submit.server", () => ({
  validateResidentApplicationRowForPersistence: async () => ({ ok: true }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
// The fee guard (own coverage in application-fee-submit-guard.test.ts) is recorded, so the test can pin which
// identity it was asked to verify the fee claim for: the account's, never the body's.
const feeGuardRows = vi.hoisted(() => [] as Array<{ email?: string }>);
vi.mock("@/lib/rental-application/application-fee-submit-guard.server", () => ({
  authorizeApplicationFeeSubmission: async (_db: unknown, row: { email?: string }) => { feeGuardRows.push({ email: row.email }); return { ok: true }; },
}));

import { POST } from "@/app/api/manager-applications/route";

const AXIS_ID = "PROPLANE-IDNTY001";
const ACCOUNT_EMAIL = "jane.applicant@example.com";

/** What the wizard sends when the template has no Full legal name / Email question. */
function submittedRow(over: Row = {}, application: Row = {}): Row {
  return {
    id: AXIS_ID,
    name: "",
    property: "Willow House",
    propertyId: "prop-willow",
    managerUserId: "mgr-1",
    stage: "Submitted",
    bucket: "pending",
    backgroundCheckStatus: "pending_review",
    detail: "Submitted now",
    email: "",
    application: { propertyId: "prop-willow", fullLegalName: "", email: "", ...application },
    ...over,
  };
}

async function postUpsert(row: Row) {
  return POST(
    new Request("http://localhost/api/manager-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "upsert", row }),
    }),
  );
}

const stored = () => state.records.find((r) => r.id === AXIS_ID);
const storedRow = () => stored()?.row_data as Row & { application?: Row };

describe("a submission whose template has no Full legal name or Email question", () => {
  beforeEach(() => {
    state.records = [];
    feeGuardRows.length = 0;
    state.user = { id: "resident-1", email: ACCOUNT_EMAIL };
    state.profile = { id: "resident-1", email: ACCOUNT_EMAIL, role: "resident", full_name: "Jane Applicant" };
  });

  it("checks the application fee claim against the account's email, not an empty or body email", async () => {
    const res = await postUpsert(submittedRow());
    expect(res.status).toBe(200);
    expect(feeGuardRows.length).toBeGreaterThan(0);
    expect(feeGuardRows.every((r) => r.email === ACCOUNT_EMAIL)).toBe(true);
  });

  it("still submits, and records the account's name and email on the row, the column and the answers", async () => {
    const res = await postUpsert(submittedRow());
    expect(res.status).toBe(200);
    expect(stored()?.resident_email).toBe(ACCOUNT_EMAIL);
    expect(storedRow()).toMatchObject({ name: "Jane Applicant", email: ACCOUNT_EMAIL, stage: "Submitted", residentUserId: "resident-1" });
    expect(storedRow().application).toMatchObject({ fullLegalName: "Jane Applicant", email: ACCOUNT_EMAIL });
  });

  it("falls back to the auth user's metadata name, then the email's local part", async () => {
    state.profile = { id: "resident-1", email: ACCOUNT_EMAIL, role: "resident", full_name: null };
    state.user = { id: "resident-1", email: ACCOUNT_EMAIL, user_metadata: { full_name: "Jane Metadata" } };
    expect((await postUpsert(submittedRow())).status).toBe(200);
    expect(storedRow().name).toBe("Jane Metadata");

    state.records = [];
    state.user = { id: "resident-1", email: ACCOUNT_EMAIL };
    expect((await postUpsert(submittedRow())).status).toBe(200);
    expect(storedRow().name).toBe("jane.applicant");
  });

  it("a body-supplied email that differs from the account never overrides it", async () => {
    const res = await postUpsert(submittedRow({ email: "mallory@evil.test" }));
    expect(res.status).toBe(403);
    expect(stored()).toBeUndefined();
  });

  it("a body-supplied name never overrides the account when the name question is absent but the name is blank", async () => {
    // The wizard cannot send a name the template does not ask for; whatever lands in `name` is the row's own
    // label, and an empty one is replaced by the account's.
    expect((await postUpsert(submittedRow({ name: "Applicant" }))).status).toBe(200);
    expect(storedRow().name).toBe("Jane Applicant");
  });

  it("a draft autosave keeps its blank name and answers but is stamped with the account's email", async () => {
    const res = await postUpsert(submittedRow({ stage: "In progress", detail: "Started now" }));
    expect(res.status).toBe(200);
    expect(stored()?.resident_email).toBe(ACCOUNT_EMAIL);
    expect(storedRow()).toMatchObject({ name: "", email: ACCOUNT_EMAIL, stage: "In progress" });
    expect(storedRow().application).toMatchObject({ fullLegalName: "", email: "" });
  });

  it("a multi-role manager applying for themselves is recorded from their account too", async () => {
    state.user = { id: "mgr-2", email: "owner@example.com" };
    state.profile = { id: "mgr-2", email: "owner@example.com", role: "manager", full_name: "Olive Owner" };
    const res = await postUpsert(submittedRow());
    expect(res.status).toBe(200);
    expect(storedRow()).toMatchObject({ name: "Olive Owner", email: "owner@example.com" });
  });

  it("never stamps a manager's own address onto somebody else's blank-email application", async () => {
    state.records = [
      {
        id: AXIS_ID,
        manager_user_id: "mgr-1",
        resident_email: null,
        property_id: "prop-willow",
        row_data: { ...submittedRow({ name: "Someone Else" }), residentUserId: "resident-9" },
      },
    ];
    state.user = { id: "mgr-1", email: "mgr@example.com" };
    state.profile = { id: "mgr-1", email: "mgr@example.com", role: "manager", full_name: "Mia Manager" };
    await postUpsert(submittedRow({ name: "Someone Else", detail: "Edited" }));
    expect(storedRow().email).not.toBe("mgr@example.com");
    expect(storedRow().name).not.toBe("Mia Manager");
  });
});

describe("a submission whose template still asks for name and email is untouched", () => {
  beforeEach(() => {
    state.records = [];
    state.user = { id: "resident-1", email: ACCOUNT_EMAIL };
    state.profile = { id: "resident-1", email: ACCOUNT_EMAIL, role: "resident", full_name: "Account Profile Name" };
  });

  it("keeps the answered name and email exactly as sent", async () => {
    const row = submittedRow(
      { name: "Jane Q Applicant", email: ACCOUNT_EMAIL },
      { fullLegalName: "Jane Q Applicant", email: "different.contact@example.com" },
    );
    expect((await postUpsert(row)).status).toBe(200);
    expect(storedRow()).toMatchObject({ name: "Jane Q Applicant", email: ACCOUNT_EMAIL });
    expect(storedRow().application).toMatchObject({ fullLegalName: "Jane Q Applicant", email: "different.contact@example.com" });
  });
});

describe("a signed-out (guest) applicant has no account to read an identity from", () => {
  beforeEach(() => {
    state.records = [{ id: "prop-willow", manager_user_id: "mgr-1", status: "live", property_data: {} }];
    feeGuardRows.length = 0;
    state.user = null;
    state.profile = null;
  });

  it("refuses a submitted application that carries no name, and stores nothing", async () => {
    const res = await postUpsert(submittedRow({ email: "guest@example.com" }));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors).toMatchObject({ fullLegalName: expect.any(String) });
    expect(stored()).toBeUndefined();
  });

  it("treats the stored placeholder name as no name", async () => {
    expect((await postUpsert(submittedRow({ email: "guest@example.com", name: "Applicant" }))).status).toBe(400);
    expect(stored()).toBeUndefined();
  });

  it("still refuses a submission with no valid email", async () => {
    expect((await postUpsert(submittedRow({ email: "", name: "Guest Person" }))).status).toBe(400);
    expect((await postUpsert(submittedRow({ email: "not-an-email", name: "Guest Person" }))).status).toBe(400);
    expect(stored()).toBeUndefined();
  });

  it("lets a draft autosave through: the applicant is still filling the form in", async () => {
    const res = await postUpsert(
      submittedRow({ email: "guest@example.com", stage: "In progress", detail: "Started now" }),
    );
    expect(res.status).toBe(200);
    expect(storedRow()).toMatchObject({ name: "", stage: "In progress" });
  });
});
