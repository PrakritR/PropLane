import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Lead review follow-up on P003 (2026-09-27): integration coverage for
 * `promoteIncompleteApplicationAfterFeePaid` itself — the function that is
 * literally "wherever a paid fee marks the application as fee-satisfied"
 * for the redirect/return checkout path. It must refuse to promote a draft
 * whose CURRENT `applicationTemplateId` no longer matches what the paid
 * Stripe session actually paid for, unless the amount paid still covers
 * what that current template requires.
 */

vi.mock("@/lib/manager-application-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-application-settings")>()),
  loadManagerApplicationSettings: async () => ({ applicationFeeCents: 5000, applicationFeeChargePolicy: "first_only" }),
}));

vi.mock("@/lib/auth/guest-application-upsert", () => ({
  prepareGuestApplicationUpsert: vi.fn(async (_db: unknown, { row }: { row: unknown }) => ({ ok: true, row, setupToken: "tok_test" })),
}));

vi.mock("@/lib/security/applicant-identity", () => ({
  openApplicantRow: (row: unknown) => row,
  sealApplicantRow: (row: unknown) => row,
  prepareApplicantIdentityWrite: (row: unknown) => row,
}));

vi.mock("@/lib/application-submitted-notification.server", () => ({
  notifyManagerApplicationSubmitted: vi.fn(async () => {}),
  shouldNotifyManagerOfApplicationSubmit: () => false,
}));

const PROPERTY_ID = "prop_1";
const MANAGER_ID = "mgr_A";
const APPLICANT_EMAIL = "applicant@example.com";

const PRICEY_TEMPLATE_ID = "app-tpl-pricey";
const CHEAP_TEMPLATE_ID = "app-tpl-cheap";

function draftRow(applicationTemplateId: string | undefined) {
  return {
    id: "AXIS-DRAFT-1",
    row_data: {
      id: "AXIS-DRAFT-1",
      stage: "Incomplete",
      bucket: "pending",
      application: {
        propertyId: PROPERTY_ID,
        email: APPLICANT_EMAIL,
        fullLegalName: "Test Applicant",
        applicationTemplateId,
      },
    },
    manager_user_id: MANAGER_ID,
    property_id: PROPERTY_ID,
    assigned_property_id: null,
    resident_email: APPLICANT_EMAIL,
  };
}

function makeDb(opts: { draftTemplateId: string | undefined; upsert?: ReturnType<typeof vi.fn> }): SupabaseClient {
  const upsert = opts.upsert ?? vi.fn(async () => ({ error: null }));
  const from = (table: string) => {
    if (table === "manager_application_records") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: async () => ({ data: [draftRow(opts.draftTemplateId)], error: null }),
            }),
          }),
        }),
        upsert,
      };
    }
    // manager_property_records — the fee re-resolution reads the listing's
    // stored templates, keying the pricey/cheap fee split by template id.
    if (table === "manager_property_records") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                manager_user_id: MANAGER_ID,
                property_data: {
                  listingSubmission: {
                    v: 1,
                    axisPaymentsEnabled: true,
                    rooms: [],
                    bathrooms: [],
                    propertyApplicationTemplates: [
                      { id: PRICEY_TEMPLATE_ID, kind: "long-term", label: "Pricey", formVariant: "standard", createdAt: "", updatedAt: "", feeCentsOverride: 9900 },
                      { id: CHEAP_TEMPLATE_ID, kind: "long-term", label: "Cheap", formVariant: "standard", createdAt: "", updatedAt: "", feeCentsOverride: 0 },
                    ],
                  },
                },
              },
              error: null,
            }),
          }),
        }),
      };
    }
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
  };
  return { from } as unknown as SupabaseClient;
}

function paidSession(overrides: Partial<{ application_template_id: string; fee_cents: string }> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test",
    status: "complete",
    payment_status: "paid",
    customer_email: APPLICANT_EMAIL,
    metadata: {
      purpose: "rental_application_fee",
      property_id: PROPERTY_ID,
      resident_email: APPLICANT_EMAIL,
      application_template_id: overrides.application_template_id ?? "",
      fee_cents: overrides.fee_cents ?? "0",
    },
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("promoteIncompleteApplicationAfterFeePaid — template/fee mismatch guard", () => {
  it("refuses to promote: paid the cheap template, draft now submits the pricier one", async () => {
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    const upsert = vi.fn(async () => ({ error: null }));
    const db = makeDb({ draftTemplateId: PRICEY_TEMPLATE_ID, upsert });

    const session = paidSession({ application_template_id: CHEAP_TEMPLATE_ID, fee_cents: "0" });
    const result = await promoteIncompleteApplicationAfterFeePaid(db, session);

    expect(result.ok).toBe(true);
    if (result.ok && result.promoted === false) {
      expect(result.reason).toBe("fee_mismatch");
      if (result.reason === "fee_mismatch") {
        expect(result.requiredCents).toBe(9900);
        expect(result.paidCents).toBe(0);
      }
    } else {
      throw new Error("expected a fee_mismatch refusal");
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it("promotes: paid and submitted the SAME template", async () => {
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    const upsert = vi.fn(async () => ({ error: null }));
    const db = makeDb({ draftTemplateId: PRICEY_TEMPLATE_ID, upsert });

    const session = paidSession({ application_template_id: PRICEY_TEMPLATE_ID, fee_cents: "9900" });
    const result = await promoteIncompleteApplicationAfterFeePaid(db, session);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.promoted).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("promotes: no templateId anywhere — the default (unchanged) path", async () => {
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    const upsert = vi.fn(async () => ({ error: null }));
    const db = makeDb({ draftTemplateId: undefined, upsert });

    const session = paidSession({ application_template_id: "", fee_cents: "5000" });
    const result = await promoteIncompleteApplicationAfterFeePaid(db, session);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.promoted).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  /**
   * Captain decision (2026-10-03): the fee is priced per room / bundle / lease type too, so the
   * guard cannot be gated on the template id. Paying for one room and then submitting under a
   * different (pricier) basis used to skip the check completely.
   */
  it("refuses to promote: the SAME template, but the paid basis is not the basis being submitted", async () => {
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    const upsert = vi.fn(async () => ({ error: null }));
    const db = makeDb({ draftTemplateId: undefined, upsert });

    const session = {
      id: "cs_test_basis",
      status: "complete",
      payment_status: "paid",
      customer_email: APPLICANT_EMAIL,
      metadata: {
        purpose: "rental_application_fee",
        property_id: PROPERTY_ID,
        resident_email: APPLICANT_EMAIL,
        application_template_id: "",
        // Paid $25 for one room; the draft about to be submitted is priced at the $50 account fee.
        fee_cents: "2500",
        fee_room_id: "room-cheap",
        fee_lease_term: "12 months",
        fee_bundle_id: "",
        fee_rental_type: "standard",
      },
    } as unknown as Stripe.Checkout.Session;

    const result = await promoteIncompleteApplicationAfterFeePaid(db, session);

    expect(result.ok).toBe(true);
    if (result.ok && result.promoted === false && result.reason === "fee_mismatch") {
      expect(result.requiredCents).toBe(5000);
      expect(result.paidCents).toBe(2500);
    } else {
      throw new Error("expected a fee_mismatch refusal");
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it("promotes: different templates, but the paid amount covers what the actual one requires", async () => {
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    const upsert = vi.fn(async () => ({ error: null }));
    const db = makeDb({ draftTemplateId: CHEAP_TEMPLATE_ID, upsert });

    // Paid for the pricey template's amount (9900) but the draft now submits
    // the cheap one (required 0) — overpaying is fine.
    const session = paidSession({ application_template_id: PRICEY_TEMPLATE_ID, fee_cents: "9900" });
    const result = await promoteIncompleteApplicationAfterFeePaid(db, session);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.promoted).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
