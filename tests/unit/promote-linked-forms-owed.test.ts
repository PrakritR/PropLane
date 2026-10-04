/**
 * Pay-then-promote: an applicant who pays the application fee has the draft promoted to Submitted by the server
 * (webhook / verify return), not by their own submit. That path must owe the same forms the direct submit does:
 * answering Yes to the built-in co-signer question (here saved as a Dropdown) on a template whose "Co-signer form"
 * is set creates the co-signer request, whether or not the manager is notified and whether the promotion or the
 * browser's own submit got there first.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } from "@/lib/property-application-templates";
import { createLinkedFormFakeDb, type LinkedFormFakeDb } from "../helpers/linked-form-fake-db";
import { buildLinkedFormListing } from "../helpers/linked-form-fixtures";

vi.mock("@/lib/auth/guest-application-upsert", () => ({
  prepareGuestApplicationUpsert: async (_db: unknown, { row }: { row: DemoApplicantRow }) => ({ ok: true, row, setupToken: "tok" }),
}));
vi.mock("@/lib/application-submitted-notification.server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    notifyManagerApplicationSubmitted: vi.fn(async () => undefined),
    // The manager is NOT notified on this path (no manager id resolved): forms must be owed regardless.
    shouldNotifyManagerOfApplicationSubmit: () => false,
  };
});
vi.mock("@/lib/move-in-forms/server", () => ({ dispatchMoveInFormsForResidencyAfterResponse: vi.fn() }));
vi.mock("@/lib/stripe-application-fee", () => ({ isApplicationFeeCheckoutSession: () => true }));
vi.mock("@/lib/stripe-axis-ach-checkout", () => ({ axisAchCheckoutPaid: () => true }));
vi.mock("@/lib/application-fee-checkout.server", () => ({
  applicationFeeBasisFromSessionMetadata: () => ({}),
  applicationFeePaymentSatisfiesTemplate: () => true,
  resolveRequiredApplicationFee: async () => ({ cents: 0, basis: {} }),
  resolveApplicationFeeProperty: async () => ({ ok: true, value: { applicationFeeCents: 0 } }),
}));
vi.mock("@/lib/auth/manager-application-access", () => ({ managerCanAccessApplicationRecord: vi.fn(async () => false) }));

const MANAGER = "11111111-1111-4111-8111-111111111111";
const ID = "PROPLANE-PROMOTE2";
const PROPERTY = "property-1";

function dropdownCosignerListing() {
  const fixture = buildLinkedFormListing();
  const main = fixture.listing.propertyApplicationTemplates.find((template) => template.id === fixture.mainId)!;
  const republished = publishApplicationTemplateQuestionDraft({
    ...main,
    draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: [],
      customApplicationFields: [
        {
          id: "ov-cosigner",
          key: "household-co-signer-planned",
          standardKey: "household-co-signer-planned",
          label: "Will someone co-sign with you?",
          type: "select",
          required: false,
          options: ["Yes", "No"],
          section: "household",
          // The shape a saved question can carry: its own (empty) rule list, never naming the co-signer form.
          linkedForms: [],
        },
      ],
    }),
  });
  return {
    ...fixture,
    listing: {
      ...fixture.listing,
      propertyApplicationTemplates: [republished, ...fixture.listing.propertyApplicationTemplates.filter((template) => template.id !== fixture.mainId)],
    },
    version: republished.publishedQuestionConfig?.version,
  };
}

function draft(templateId: string, version: number | undefined, hasCosigner: string): DemoApplicantRow {
  return {
    id: ID,
    name: "Riley Tester",
    email: "riley@example.com",
    property: "Cascade Lofts",
    propertyId: PROPERTY,
    stage: "In progress",
    bucket: "pending",
    detail: "",
    managerUserId: MANAGER,
    residentUserId: "applicant-1",
    application: {
      propertyId: PROPERTY,
      applicationTemplateId: templateId,
      applicationTemplateVersion: version,
      fullLegalName: "Riley Tester",
      email: "riley@example.com",
      ssn: "123-45-6780",
      dateOfBirth: "1997-05-20",
      driversLicense: "WDL7654321",
      hasCosigner,
      applyingAsGroup: "no",
    } as DemoApplicantRow["application"],
  };
}

const session = {
  id: "cs_test_2",
  metadata: { property_id: PROPERTY, resident_email: "riley@example.com" },
} as unknown as Stripe.Checkout.Session;

function seed(fixture: ReturnType<typeof dropdownCosignerListing>, row: DemoApplicantRow): { db: LinkedFormFakeDb; cosignerId: string } {
  const db = createLinkedFormFakeDb({
    manager_property_records: [{ id: PROPERTY, manager_user_id: MANAGER, property_data: { listingSubmission: fixture.listing } }],
    manager_application_records: [
      {
        id: ID,
        manager_user_id: MANAGER,
        resident_email: "riley@example.com",
        property_id: PROPERTY,
        assigned_property_id: null,
        updated_at: new Date().toISOString(),
        row_data: sealApplicantRow(row, ID, MANAGER),
      },
    ],
  });
  return { db, cosignerId: fixture.cosignerId };
}

beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
});

describe("pay-then-promote owes the linked forms", () => {
  it("creates the co-signer request when a Dropdown co-signer question was answered Yes", async () => {
    const fixture = dropdownCosignerListing();
    const { db, cosignerId } = seed(fixture, draft(fixture.mainId, fixture.version, "yes"));
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");

    const result = await promoteIncompleteApplicationAfterFeePaid(db as never, session);

    expect(result).toMatchObject({ ok: true, promoted: true, axisId: ID });
    const owed = db.tables.application_form_requests ?? [];
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({
      application_id: ID,
      applicant_user_id: "applicant-1",
      form_kind: "application",
      form_id: cosignerId,
      status: "owed",
      needed_before_review: true,
      source_question_label: "Will someone co-sign with you?",
      source_answer_label: "Yes",
    });
  });

  it("owes nothing when the applicant answered No", async () => {
    const fixture = dropdownCosignerListing();
    const { db } = seed(fixture, draft(fixture.mainId, fixture.version, "no"));
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    await promoteIncompleteApplicationAfterFeePaid(db as never, session);
    expect(db.tables.application_form_requests ?? []).toHaveLength(0);
  });

  it("still owes it when the draft never recorded which application form it used", async () => {
    const fixture = dropdownCosignerListing();
    const { db, cosignerId } = seed(fixture, draft("", undefined, "yes"));
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    await promoteIncompleteApplicationAfterFeePaid(db as never, session);
    expect((db.tables.application_form_requests ?? []).map((request) => request.form_id)).toEqual([cosignerId]);
    expect(fixture.mainId).toBeTruthy();
  });

  it("heals an application the browser's own submit finished first (already submitted, nothing owed yet)", async () => {
    const fixture = dropdownCosignerListing();
    const submitted = { ...draft(fixture.mainId, fixture.version, "yes"), stage: "Submitted" };
    const { db, cosignerId } = seed(fixture, submitted);
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");

    const result = await promoteIncompleteApplicationAfterFeePaid(db as never, session);
    expect(result).toMatchObject({ ok: true, promoted: false, reason: "already_submitted", axisId: ID });
    expect((db.tables.application_form_requests ?? []).map((request) => request.form_id)).toEqual([cosignerId]);

    // A second pass (the webhook after the verify return) never doubles the list.
    await promoteIncompleteApplicationAfterFeePaid(db as never, session);
    expect(db.tables.application_form_requests).toHaveLength(1);
  });
});
