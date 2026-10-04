import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkedFormFakeDb, type LinkedFormFakeDb } from "../helpers/linked-form-fake-db";
import { buildLinkedFormListing } from "../helpers/linked-form-fixtures";
import { hashLinkedFormToken } from "@/lib/application-linked-form-requests.server";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  db: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "127.0.0.1" }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => ({ roles: ["resident"], effectiveRole: "resident" }) }));
vi.mock("@/lib/auth/manager-application-access", () => ({
  managerCanAccessApplicationRecord: async (_db: unknown, userId: string) => userId === "manager-1",
}));
vi.mock("@/lib/application-fee-checkout.server", () => ({
  resolveApplicationFeeProperty: async () => ({ ok: true, value: { applicationFeeCents: 4500 } }),
  resolveApplicationFeeItemization: async () => ({ managerTier: "free", feePayer: "proplane" }),
}));
vi.mock("@/lib/cosigner-notification.server", () => ({ notifyManagerCosignerSubmitted: async () => undefined }));

import { POST as redeem } from "@/app/api/linked-form-requests/redeem/route";
import { POST as submitCosigner } from "@/app/api/public/cosigner-submissions/route";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "K".repeat(43);

function seed(overrides: Record<string, unknown> = {}): LinkedFormFakeDb {
  const { listing, cosignerId } = buildLinkedFormListing();
  return createLinkedFormFakeDb({
    manager_property_records: [{ id: "property-1", manager_user_id: "manager-1", property_data: { listingSubmission: listing } }],
    manager_application_records: [
      {
        id: "PROPLANE-APP00001",
        manager_user_id: "manager-1",
        property_id: "property-1",
        assigned_property_id: null,
        resident_email: "ava@example.com",
        row_data: {
          id: "PROPLANE-APP00001",
          name: "Ava Lee",
          email: "ava@example.com",
          residentUserId: "applicant-1",
          bucket: "approved",
          stage: "Approved",
          propertyId: "property-1",
          application: { propertyId: "property-1", hasCosigner: "yes" },
        },
      },
    ],
    application_form_requests: [
      {
        id: REQUEST_ID,
        manager_user_id: "manager-1",
        application_id: "PROPLANE-APP00001",
        applicant_user_id: "applicant-1",
        helper_user_id: "helper-1",
        rule_id: "r",
        form_kind: "application",
        form_id: cosignerId,
        source_question_label: "Co-signer planned",
        source_answer_label: "Yes",
        needed_before_review: true,
        token_hash: hashLinkedFormToken(TOKEN),
        status: "shared",
        filled_by_user_id: null,
        fee_cents: 4500,
        fee_paid_at: null,
        fee_paid_by_user_id: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        ...overrides,
      },
    ],
    profiles: [
      { id: "helper-1", role: "resident", email: "mom@example.com" },
      { id: "helper-2", role: "resident", email: "dad@example.com" },
      { id: "manager-1", role: "manager", email: "m@example.com" },
    ],
    profile_roles: [],
    cosigner_submission_records: [],
  });
}

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function cosignerBody(cosignerId: string, extra: Record<string, unknown> = {}) {
  return {
    signerAppId: "PROPLANE-SOMEONE-ELSE",
    applicationTemplateId: "attacker-picked-template",
    signerFullName: "Ava Lee",
    fullName: "Maria Lee",
    email: "mom@example.com",
    phone: "2065550123",
    dob: "1970-01-01",
    ssn: "123-45-6789",
    consentCredit: true,
    signature: "Maria Lee",
    dateSigned: "2026-10-04",
    customFieldAnswers: [
      { key: "co_income", value: "Employed" },
      { key: "co_employer", value: "Acme" },
    ],
    ...extra,
    formRequestId: REQUEST_ID,
    _cosignerId: cosignerId,
  };
}

describe("POST /api/linked-form-requests/redeem", () => {
  beforeEach(() => {
    state.user = { id: "helper-2", email: "dad@example.com" };
    state.db = seed({ helper_user_id: null });
  });

  it("opens a live link for a signed-in resident account and returns the fill page", async () => {
    const res = await redeem(post("/api/linked-form-requests/redeem", { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, requestId: REQUEST_ID, role: "helper", path: `/f/open/${REQUEST_ID}`, formLabel: "Co-signer form" });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("needs a sign-in, and answers a wrong, expired or non-resident visitor with one identical refusal", async () => {
    state.user = null;
    expect((await redeem(post("/api/linked-form-requests/redeem", { token: TOKEN }))).status).toBe(401);

    state.user = { id: "helper-2", email: "dad@example.com" };
    const wrong = await redeem(post("/api/linked-form-requests/redeem", { token: "Z".repeat(43) }));

    state.db = seed({ helper_user_id: null, expires_at: new Date(Date.now() - 1000).toISOString() });
    const expired = await redeem(post("/api/linked-form-requests/redeem", { token: TOKEN }));

    state.db = seed({ helper_user_id: null });
    state.user = { id: "manager-1", email: "m@example.com" };
    const notResident = await redeem(post("/api/linked-form-requests/redeem", { token: TOKEN }));

    for (const res of [wrong, expired, notResident]) expect(res.status).toBe(404);
    const bodies = await Promise.all([wrong, expired, notResident].map((res) => res.text()));
    expect(new Set(bodies).size).toBe(1);
    // No detail about the application, the form, or why.
    expect(bodies[0]).not.toMatch(/Ava|Co-signer|expired|PROPLANE/i);
  });
});

describe("a linked form submitted through the co-signer route", () => {
  let cosignerId: string;

  beforeEach(() => {
    cosignerId = buildLinkedFormListing().cosignerId;
    state.user = { id: "helper-1", email: "mom@example.com" };
    state.db = seed();
  });

  // The template ids differ per build, so the seeded request is re-pointed at this listing's co-signer form.
  function pointAtCosigner(db: LinkedFormFakeDb) {
    const listing = (db.tables.manager_property_records![0]!.property_data as { listingSubmission: { propertyApplicationTemplates: Array<{ id: string; formVariant?: string }> } }).listingSubmission;
    const cosigner = listing.propertyApplicationTemplates.find((template) => template.formVariant === "cosigner")!;
    db.tables.application_form_requests![0]!.form_id = cosigner.id;
    return cosigner.id;
  }

  it("requires a signed-in person", async () => {
    state.user = null;
    const res = await submitCosigner(post("/api/public/cosigner-submissions", cosignerBody(cosignerId)));
    expect(res.status).toBe(401);
  });

  it("answers a manager or a stranger exactly as for a request that does not exist", async () => {
    for (const user of [{ id: "manager-1", email: "m@example.com" }, { id: "stranger", email: "x@example.com" }]) {
      state.user = user;
      const res = await submitCosigner(post("/api/public/cosigner-submissions", cosignerBody(cosignerId)));
      expect(res.status).toBe(404);
    }
    state.user = { id: "helper-1", email: "mom@example.com" };
    const missing = await submitCosigner(post("/api/public/cosigner-submissions", { ...cosignerBody(cosignerId), formRequestId: "33333333-3333-4333-8333-333333333333" }));
    expect(missing.status).toBe(404);
  });

  it("holds the submit until the person submitting has paid the form's fee", async () => {
    const db = state.db as LinkedFormFakeDb;
    pointAtCosigner(db);
    const unpaid = await submitCosigner(post("/api/public/cosigner-submissions", cosignerBody(cosignerId)));
    expect(unpaid.status).toBe(402);
    expect((await unpaid.json()).code).toBe("FEE_REQUIRED");

    // Paid by someone else: the fee is the submitter's, so it still holds.
    Object.assign(db.tables.application_form_requests![0]!, { fee_paid_at: new Date().toISOString(), fee_paid_by_user_id: "helper-2" });
    expect((await submitCosigner(post("/api/public/cosigner-submissions", cosignerBody(cosignerId)))).status).toBe(402);
    expect(db.tables.cosigner_submission_records).toHaveLength(0);
    expect(db.tables.application_form_requests![0]!.status).toBe("shared");
  });

  it("saves against the request's own application and form, finishes it, and records who filled it in", async () => {
    const db = state.db as LinkedFormFakeDb;
    const formId = pointAtCosigner(db);
    Object.assign(db.tables.application_form_requests![0]!, { fee_paid_at: new Date().toISOString(), fee_paid_by_user_id: "helper-1" });

    const res = await submitCosigner(post("/api/public/cosigner-submissions", cosignerBody(cosignerId)));
    expect(res.status).toBe(200);
    const saved = db.tables.cosigner_submission_records![0]!;
    // The body named a different application and template; the stored request decides both.
    expect(saved.signer_app_id).toBe("PROPLANE-APP00001");
    expect(saved.manager_user_id).toBe("manager-1");
    expect((saved.row_data as { applicationTemplateId?: string }).applicationTemplateId).toBe(formId);
    expect(db.tables.application_form_requests![0]).toMatchObject({
      status: "done",
      filled_by_user_id: "helper-1",
      fee_paid_by_user_id: "helper-1",
      completed_submission_ref: saved.id,
    });

    // A finished form cannot be filled twice.
    const again = await submitCosigner(post("/api/public/cosigner-submissions", cosignerBody(cosignerId)));
    expect(again.status).toBe(409);
    expect(db.tables.cosigner_submission_records).toHaveLength(1);
  });

  it("an expired request is refused like a missing one", async () => {
    const db = state.db as LinkedFormFakeDb;
    pointAtCosigner(db);
    db.tables.application_form_requests![0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await submitCosigner(post("/api/public/cosigner-submissions", cosignerBody(cosignerId)))).status).toBe(404);
  });

  it("the legacy public co-signer link keeps working and still finishes the request it opened", async () => {
    const db = state.db as LinkedFormFakeDb;
    const formId = pointAtCosigner(db);
    state.user = null;
    const { formRequestId: _ignored, _cosignerId: _unused, ...legacy } = cosignerBody(cosignerId);
    void _ignored;
    void _unused;
    const res = await submitCosigner(
      post("/api/public/cosigner-submissions", { ...legacy, signerAppId: "PROPLANE-APP00001", applicationTemplateId: formId }),
    );
    expect(res.status).toBe(200);
    expect(db.tables.cosigner_submission_records).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.tables.application_form_requests![0]).toMatchObject({ status: "done", filled_by_user_id: null });
  });
});
