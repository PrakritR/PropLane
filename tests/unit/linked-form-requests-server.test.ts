import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkedFormFakeDb, type LinkedFormFakeDb } from "../helpers/linked-form-fake-db";
import { buildLinkedFormListing } from "../helpers/linked-form-fixtures";

vi.mock("@/lib/application-fee-checkout.server", () => ({
  resolveApplicationFeeProperty: vi.fn(async (_db: unknown, input: { applicationTemplateId?: string }) => ({
    ok: true,
    value: { applicationFeeCents: input.applicationTemplateId === "TEMPLATE-WITH-FEE" ? 4500 : 0 },
  })),
}));
vi.mock("@/lib/auth/manager-application-access", () => ({
  managerCanAccessApplicationRecord: vi.fn(async (_db: unknown, userId: string) => userId === "manager-1"),
}));

import { createLinkedFormRequestsForSubmit, completeLinkedFormRequest, hashLinkedFormToken, loadLinkedFormRequest, mintLinkedFormToken, redeemLinkedFormToken, resolveLinkedFormViewerRole, rotateLinkedFormToken, toLinkedFormRequestViews, loadApplicationAccessRow } from "@/lib/application-linked-form-requests.server";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const buildListing = buildLinkedFormListing;

function applicationRow(overrides: Record<string, unknown> = {}, applicationOverrides: Record<string, unknown> = {}) {
  return {
    id: "PROPLANE-APP00001",
    name: "Ava Lee",
    email: "ava@example.com",
    managerUserId: "manager-1",
    residentUserId: "applicant-1",
    propertyId: "property-1",
    bucket: "pending",
    application: {
      propertyId: "property-1",
      applicationTemplateId: undefined as string | undefined,
      hasCosigner: "yes",
      customFieldAnswers: [{ key: "has_pets", label: "Do you have pets?", type: "select", section: "additional", value: "Yes" }],
      ...applicationOverrides,
    },
    ...overrides,
  };
}

function seedDb(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  const fixture = buildListing();
  const db = createLinkedFormFakeDb({
    manager_property_records: [{ id: "property-1", manager_user_id: "manager-1", property_data: { listingSubmission: fixture.listing } }],
    ...extra,
  });
  return { db, ...fixture };
}

describe("linked forms are owed on submit", () => {
  it("creates one request per matched rule, keeps the co-signer behaviour, and stores only a token hash", async () => {
    const { db, mainId, cosignerId, petFormId } = seedDb();
    const row = applicationRow({}, { applicationTemplateId: mainId });
    // The applicant's login comes from the authenticated session the caller proved, never from the client row.
    const issued = await createLinkedFormRequestsForSubmit(db, { applicationId: row.id, row: row as never, applicantUserId: "applicant-1" });

    expect(issued.map((form) => `${form.formKind}:${form.formId}`).sort()).toEqual([`application:${cosignerId}`, `move_in:${petFormId}`].sort());
    const stored = db.tables.application_form_requests!;
    expect(stored).toHaveLength(2);

    const cosigner = stored.find((request) => request.form_kind === "application")!;
    expect(cosigner).toMatchObject({
      manager_user_id: "manager-1",
      application_id: row.id,
      applicant_user_id: "applicant-1",
      needed_before_review: true,
      status: "owed",
      fee_cents: 0, // the mocked fee resolver answers 0 for this id; the amount is never read from the body
      source_question_label: "Co-signer planned",
    });
    const pets = stored.find((request) => request.form_kind === "move_in")!;
    expect(pets).toMatchObject({ source_question_label: "Do you have pets?", source_answer_label: "Yes", needed_before_review: false });

    // Only the hash is stored; the token handed back hashes to it.
    for (const request of stored) {
      expect(String(request.token_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(request).not.toHaveProperty("token");
    }
    for (const form of issued) {
      const row = stored.find((request) => request.id === form.id)!;
      expect(sha256(form.shareToken)).toBe(row.token_hash);
      expect(form.shareToken).toHaveLength(43); // 32 random bytes, base64url
      expect(form.sharePath).toBe(`/f/${form.shareToken}`);
    }
    // Every request carries a 30-day expiry.
    for (const request of stored) {
      const days = (new Date(String(request.expires_at)).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
    }
  });

  it("never takes the applicant's login from the client-authored row", async () => {
    const { db, mainId } = seedDb();
    const row = applicationRow({ residentUserId: "someone-elses-account" }, { applicationTemplateId: mainId });
    await createLinkedFormRequestsForSubmit(db, { applicationId: row.id, row: row as never });
    expect(db.tables.application_form_requests!.length).toBeGreaterThan(0);
    for (const request of db.tables.application_form_requests!) expect(request.applicant_user_id).toBeNull();

    const other = seedDb();
    const signed = applicationRow({ residentUserId: "someone-elses-account" }, { applicationTemplateId: other.mainId });
    await createLinkedFormRequestsForSubmit(other.db, { applicationId: signed.id, row: signed as never, applicantUserId: "session-user" });
    for (const request of other.db.tables.application_form_requests!) expect(request.applicant_user_id).toBe("session-user");
  });

  it("owes the property's default co-signer form when the template's Co-signer form is Property default", async () => {
    const fixture = buildListing();
    const listing = {
      ...fixture.listing,
      propertyApplicationTemplates: fixture.listing.propertyApplicationTemplates.map((template) =>
        template.id === fixture.mainId ? { ...template, linkedCosignerApplicationTemplateId: null } : template,
      ),
    };
    const db = createLinkedFormFakeDb({
      manager_property_records: [{ id: "property-1", manager_user_id: "manager-1", property_data: { listingSubmission: listing } }],
    });
    const row = applicationRow({}, { applicationTemplateId: fixture.mainId, customFieldAnswers: [] });
    const issued = await createLinkedFormRequestsForSubmit(db, { applicationId: row.id, row: row as never });
    expect(issued.map((form) => `${form.formKind}:${form.formId}`)).toEqual([`application:${fixture.cosignerId}`]);
    expect(db.tables.application_form_requests).toHaveLength(1);

    const no = applicationRow({}, { applicationTemplateId: fixture.mainId, customFieldAnswers: [], hasCosigner: "no" });
    expect(await createLinkedFormRequestsForSubmit(db, { applicationId: "PROPLANE-APP00002", row: { ...no, id: "PROPLANE-APP00002" } as never })).toEqual([]);
  });

  it("resolves each application form's own fee on the server", async () => {
    const { db, mainId, cosignerId } = seedDb();
    const resolve = (await import("@/lib/application-fee-checkout.server")).resolveApplicationFeeProperty as ReturnType<typeof vi.fn>;
    resolve.mockImplementationOnce(async () => ({ ok: true, value: { applicationFeeCents: 4500 } }));
    const row = applicationRow({}, { applicationTemplateId: mainId });
    await createLinkedFormRequestsForSubmit(db, { applicationId: row.id, row: row as never });
    const cosigner = db.tables.application_form_requests!.find((request) => request.form_id === cosignerId)!;
    expect(cosigner.fee_cents).toBe(4500);
    expect(resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ applicationTemplateId: cosignerId, managerUserId: "manager-1" }), { allowZeroFee: true });
    // A move-in form never charges.
    expect(db.tables.application_form_requests!.find((request) => request.form_kind === "move_in")!.fee_cents).toBeNull();
  });

  it("dedupes a re-submit and owes nothing when no rule matches", async () => {
    const { db, mainId } = seedDb();
    const row = applicationRow({}, { applicationTemplateId: mainId });
    await createLinkedFormRequestsForSubmit(db, { applicationId: row.id, row: row as never });
    const again = await createLinkedFormRequestsForSubmit(db, { applicationId: row.id, row: row as never });
    expect(again).toEqual([]);
    expect(db.tables.application_form_requests).toHaveLength(2);

    const none = seedDb();
    const noRow = applicationRow({}, { applicationTemplateId: none.mainId, hasCosigner: "no", customFieldAnswers: [] });
    expect(await createLinkedFormRequestsForSubmit(none.db, { applicationId: noRow.id, row: noRow as never })).toEqual([]);
    expect(none.db.tables.application_form_requests ?? []).toHaveLength(0);
  });

  it("never throws into the application submit", async () => {
    const broken = createLinkedFormFakeDb({});
    expect(await createLinkedFormRequestsForSubmit(broken, { applicationId: "x", row: { id: "x" } as never })).toEqual([]);
  });
});

describe("tokens", () => {
  it("mints 32 random bytes and hashes with SHA-256", () => {
    const a = mintLinkedFormToken();
    const b = mintLinkedFormToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toHaveLength(43);
    expect(a.tokenHash).toBe(sha256(a.token));
    expect(hashLinkedFormToken(` ${a.token} `)).toBe(a.tokenHash);
  });
});

describe("opening a share link", () => {
  const TOKEN = "T".repeat(43);
  let db: LinkedFormFakeDb;

  beforeEach(() => {
    db = createLinkedFormFakeDb({
      manager_application_records: [
        {
          id: "PROPLANE-APP00001",
          manager_user_id: "manager-1",
          property_id: "property-1",
          assigned_property_id: null,
          resident_email: "ava@example.com",
          row_data: { id: "PROPLANE-APP00001", name: "Ava Lee", email: "ava@example.com", residentUserId: "applicant-1" },
        },
      ],
      application_form_requests: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          manager_user_id: "manager-1",
          application_id: "PROPLANE-APP00001",
          applicant_user_id: "applicant-1",
          helper_user_id: null,
          rule_id: "r",
          form_kind: "application",
          form_id: "cosigner-form",
          source_question_label: "Co-signer planned",
          source_answer_label: "Yes",
          needed_before_review: true,
          token_hash: hashLinkedFormToken(TOKEN),
          status: "shared",
          filled_by_user_id: null,
          fee_cents: 4500,
          fee_paid_at: null,
          fee_paid_by_user_id: null,
          expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        },
      ],
      profiles: [{ id: "applicant-1", email: "ava@example.com" }],
    });
  });

  it("links a helper's resident account to the applicant for this one form", async () => {
    const result = await redeemLinkedFormToken(db, TOKEN, { id: "helper-1", email: "mom@example.com" });
    expect(result).toMatchObject({ ok: true, role: "helper" });
    expect(db.tables.resident_account_links).toEqual([
      expect.objectContaining({ application_id: "PROPLANE-APP00001", applicant_user_id: "applicant-1", helper_user_id: "helper-1" }),
    ]);
    expect(db.tables.application_form_requests![0]!.helper_user_id).toBe("helper-1");

    // Opening it again is idempotent: one link row per pair per application.
    await redeemLinkedFormToken(db, TOKEN, { id: "helper-1", email: "mom@example.com" });
    expect(db.tables.resident_account_links).toHaveLength(1);

    // The helper can now see exactly this request; nobody else can.
    const request = (await loadLinkedFormRequest(db, "11111111-1111-4111-8111-111111111111"))!;
    expect(await resolveLinkedFormViewerRole(db, request, { id: "helper-1", email: "mom@example.com" })).toMatchObject({ role: "helper" });
    expect(await resolveLinkedFormViewerRole(db, request, { id: "stranger", email: "x@example.com" })).toBeNull();
    expect(await resolveLinkedFormViewerRole(db, request, { id: "applicant-1", email: "ava@example.com" })).toMatchObject({ role: "applicant" });
    expect(await resolveLinkedFormViewerRole(db, request, { id: "manager-1", email: "m@example.com" })).toMatchObject({ role: "manager" });
  });

  it("refuses a second person once the link is taken, and the applicant's own open is not a link", async () => {
    await redeemLinkedFormToken(db, TOKEN, { id: "helper-1", email: "mom@example.com" });
    expect(await redeemLinkedFormToken(db, TOKEN, { id: "helper-2", email: "dad@example.com" })).toEqual({ ok: false });
    expect(db.tables.resident_account_links).toHaveLength(1);

    const own = await redeemLinkedFormToken(db, TOKEN, { id: "applicant-1", email: "ava@example.com" });
    expect(own).toMatchObject({ ok: true, role: "applicant" });
    expect(db.tables.resident_account_links).toHaveLength(1);
  });

  it("refuses a wrong, expired, finished or manager-opened link identically", async () => {
    const stranger = { id: "helper-9", email: "x@example.com" };
    const wrong = await redeemLinkedFormToken(db, "W".repeat(43), stranger);
    const malformed = await redeemLinkedFormToken(db, "short", stranger);
    db.tables.application_form_requests![0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    const expired = await redeemLinkedFormToken(db, TOKEN, stranger);
    db.tables.application_form_requests![0]!.expires_at = new Date(Date.now() + 86_400_000).toISOString();
    db.tables.application_form_requests![0]!.status = "done";
    const finished = await redeemLinkedFormToken(db, TOKEN, stranger);
    db.tables.application_form_requests![0]!.status = "shared";
    const manager = await redeemLinkedFormToken(db, TOKEN, { id: "manager-1", email: "m@example.com" });

    for (const refusal of [wrong, malformed, expired, finished, manager]) expect(refusal).toEqual({ ok: false });
    expect(db.tables.resident_account_links ?? []).toHaveLength(0);
    expect(db.tables.application_form_requests![0]!.helper_user_id).toBeNull();
  });

  it("a helper can still open it before the applicant has an account (no link row to write yet)", async () => {
    db.tables.application_form_requests![0]!.applicant_user_id = null;
    db.tables.manager_application_records![0]!.row_data = { id: "PROPLANE-APP00001", name: "Ava Lee", email: "ava@example.com" };
    db.tables.profiles = [];
    const result = await redeemLinkedFormToken(db, TOKEN, { id: "helper-1", email: "mom@example.com" });
    expect(result).toMatchObject({ ok: true, role: "helper" });
    expect(db.tables.resident_account_links ?? []).toHaveLength(0);
    expect(db.tables.application_form_requests![0]!.helper_user_id).toBe("helper-1");
  });

  it("showing the link again keeps the helper who already holds it", async () => {
    await redeemLinkedFormToken(db, TOKEN, { id: "helper-1", email: "mom@example.com" });
    const request = (await loadLinkedFormRequest(db, "11111111-1111-4111-8111-111111111111"))!;
    const shown = await rotateLinkedFormToken(db, request);
    expect(shown?.token).toHaveLength(43);
    expect(db.tables.application_form_requests![0]!.helper_user_id).toBe("helper-1");
    // The helper part-way through the form is still the helper, on the link they now hold.
    expect(await redeemLinkedFormToken(db, shown!.token, { id: "helper-1", email: "mom@example.com" })).toMatchObject({
      ok: true,
      role: "helper",
    });
  });

  it("an explicit new link replaces the old one and starts a new hand-off", async () => {
    await redeemLinkedFormToken(db, TOKEN, { id: "helper-1", email: "mom@example.com" });
    const request = (await loadLinkedFormRequest(db, "11111111-1111-4111-8111-111111111111"))!;
    const next = await rotateLinkedFormToken(db, request, { revokeHelper: true });
    expect(next?.token).toHaveLength(43);
    expect(next?.path).toBe(`/f/${next!.token}`);
    expect(db.tables.application_form_requests![0]!.token_hash).toBe(sha256(next!.token));
    expect(db.tables.application_form_requests![0]!.helper_user_id).toBeNull();
    expect(await redeemLinkedFormToken(db, TOKEN, { id: "helper-2", email: "dad@example.com" })).toEqual({ ok: false });
    expect(await redeemLinkedFormToken(db, next!.token, { id: "helper-2", email: "dad@example.com" })).toMatchObject({ ok: true });
  });

  it("finishing records who filled it in, once", async () => {
    expect(await completeLinkedFormRequest(db, "11111111-1111-4111-8111-111111111111", { filledByUserId: "helper-1", submissionRef: "cosigner-abc" })).toBe(true);
    expect(db.tables.application_form_requests![0]).toMatchObject({ status: "done", filled_by_user_id: "helper-1", completed_submission_ref: "cosigner-abc" });
    expect(await completeLinkedFormRequest(db, "11111111-1111-4111-8111-111111111111", { filledByUserId: "helper-2", submissionRef: "other" })).toBe(false);
    expect(db.tables.application_form_requests![0]!.filled_by_user_id).toBe("helper-1");
    // A finished request has no link to give.
    const request = (await loadLinkedFormRequest(db, "11111111-1111-4111-8111-111111111111"))!;
    expect(await rotateLinkedFormToken(db, request)).toBeNull();
  });

  it("views never carry a token or hash", async () => {
    const app = (await loadApplicationAccessRow(db, "PROPLANE-APP00001"))!;
    const request = (await loadLinkedFormRequest(db, "11111111-1111-4111-8111-111111111111"))!;
    const [view] = await toLinkedFormRequestViews(db, [{ request, viewerRole: "manager", app }]);
    expect(JSON.stringify(view)).not.toMatch(/token/i);
    expect(view).toMatchObject({ viewerRole: "manager", applicantName: "Ava Lee", status: "shared", feeCents: 4500, feePaid: false });
  });
});
