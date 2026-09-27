import { describe, expect, it, vi } from "vitest";

/**
 * Lead review follow-up on P003 (2026-09-27): an applicant chooses
 * `applicationTemplateId` when requesting a fee preview/checkout, so a
 * dishonest one could pay for a CHEAP template (e.g. a $0 override) while
 * actually submitting the application under a different, pricier one.
 * `applicationFeePaymentSatisfiesTemplate` is the one pure decision that
 * closes it: same template paid/submitted is always fine; a different
 * template is fine only when what was paid covers what the ACTUAL template
 * now requires.
 */
import { applicationFeePaymentSatisfiesTemplate } from "@/lib/application-fee-checkout.server";

describe("applicationFeePaymentSatisfiesTemplate", () => {
  it("NOT satisfied: paid a cheap template, submitted a pricier one", () => {
    const satisfied = applicationFeePaymentSatisfiesTemplate({
      submittedApplicationTemplateId: "app-tpl-pricey",
      paidApplicationTemplateId: "app-tpl-cheap",
      paidFeeCents: 0,
      requiredFeeCents: 5000,
    });
    expect(satisfied).toBe(false);
  });

  it("satisfied: paid and submitted the SAME template", () => {
    const satisfied = applicationFeePaymentSatisfiesTemplate({
      submittedApplicationTemplateId: "app-tpl-long",
      paidApplicationTemplateId: "app-tpl-long",
      paidFeeCents: 0,
      requiredFeeCents: 5000,
    });
    // Same template is always satisfied by construction — it is the exact
    // charge the applicant already completed, regardless of amount (the
    // amount itself was already validated server-side at checkout time).
    expect(satisfied).toBe(true);
  });

  it("satisfied: no templateId on either side — the default (unchanged) path", () => {
    const satisfied = applicationFeePaymentSatisfiesTemplate({
      submittedApplicationTemplateId: undefined,
      paidApplicationTemplateId: undefined,
      paidFeeCents: 5000,
      requiredFeeCents: 5000,
    });
    expect(satisfied).toBe(true);
  });

  it("satisfied: null and empty string both normalize to 'no template'", () => {
    expect(
      applicationFeePaymentSatisfiesTemplate({
        submittedApplicationTemplateId: null,
        paidApplicationTemplateId: "",
        paidFeeCents: 5000,
        requiredFeeCents: 5000,
      }),
    ).toBe(true);
  });

  it("satisfied: different templates, but the paid amount covers what's now required (overpaying, or two templates priced the same)", () => {
    const satisfied = applicationFeePaymentSatisfiesTemplate({
      submittedApplicationTemplateId: "app-tpl-b",
      paidApplicationTemplateId: "app-tpl-a",
      paidFeeCents: 5000,
      requiredFeeCents: 3500,
    });
    expect(satisfied).toBe(true);
  });

  it("NOT satisfied: different templates, paid amount short of what's required by a single cent", () => {
    const satisfied = applicationFeePaymentSatisfiesTemplate({
      submittedApplicationTemplateId: "app-tpl-b",
      paidApplicationTemplateId: "app-tpl-a",
      paidFeeCents: 3499,
      requiredFeeCents: 3500,
    });
    expect(satisfied).toBe(false);
  });
});

describe("resolveRequiredApplicationFeeCents — reuses the existing resolver, no second fee calculation", () => {
  it("delegates to resolveApplicationFeeProperty with allowZeroFee and returns its cents", async () => {
    vi.resetModules();
    vi.doMock("@/lib/manager-application-settings", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/manager-application-settings")>()),
      loadManagerApplicationSettings: async () => ({ applicationFeeCents: 5000, applicationFeeChargePolicy: "first_only" }),
    }));
    const { resolveRequiredApplicationFeeCents } = await import("@/lib/application-fee-checkout.server");
    const db = {
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => {
          if (table === "manager_property_records") {
            return {
              data: {
                manager_user_id: "mgr_A",
                property_data: {
                  listingSubmission: {
                    v: 1,
                    axisPaymentsEnabled: true,
                    rooms: [],
                    bathrooms: [],
                    propertyApplicationTemplates: [
                      { id: "app-tpl-pricey", kind: "long-term", label: "Pricey", formVariant: "standard", createdAt: "", updatedAt: "", feeCentsOverride: 9900 },
                    ],
                  },
                },
              },
              error: null,
            };
          }
          return { data: null, error: null };
        };
        return chain;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const cents = await resolveRequiredApplicationFeeCents(db, {
      propertyId: "prop_1",
      managerUserId: "mgr_A",
      applicationTemplateId: "app-tpl-pricey",
    });
    expect(cents).toBe(9900);

    const fallback = await resolveRequiredApplicationFeeCents(db, {
      propertyId: "prop_1",
      managerUserId: "mgr_A",
      applicationTemplateId: "does-not-exist",
    });
    expect(fallback).toBe(5000);
    vi.doUnmock("@/lib/manager-application-settings");
  });
});
