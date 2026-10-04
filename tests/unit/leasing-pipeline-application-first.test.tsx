/**
 * @vitest-environment jsdom
 *
 * Leasing pipeline, phase A: the application always opens with "Which lease are you applying
 * for?" (lease type + room or home, before any other question), that choice drives the form, the
 * fee and the lease, and each application form can say "before the tour" / "after the tour" /
 * "use the workspace setting".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, render } from "@testing-library/react";

vi.mock("server-only", () => ({}));

import { RentalWizardStepBody, type WizardStepsProps } from "@/components/marketing/rental-wizard-steps";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
import { RENTAL_WIZARD_STEP_TITLES } from "@/lib/rental-application/wizard-step-titles";
import { hasLeaseChoiceError, validateRentalWizardStep } from "@/lib/rental-application/validate";
import { placementApplicationFeeCents, placementFeeOptionsFor } from "@/lib/listing-placement-standard-fees";
import { applicationPinForStayTerm } from "@/lib/property-form-stay-type-routing";
import {
  leaseTemplateIdForApplication,
  listLeaseTemplateGenerateChoices,
  resolvePropertyLeaseTemplateForApplication,
  submissionWithLeaseTemplateById,
  submissionWithLeaseTemplateForApplication,
} from "@/lib/property-lease-template-sync";
import {
  createPropertyApplicationTemplate,
  readPropertyApplicationTemplates,
  type ApplicationTemplateQuestionConfig,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate, readPropertyLeaseTemplates, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import {
  applicationBeforeTourRequired,
  formRequiresApplicationBeforeTour,
  normalizeApplicationTourOrder,
} from "@/lib/application-before-tour-policy";
import { resolveApplicationBeforeTour, applicationBeforeTourRefusal } from "@/lib/application-before-tour.server";

const PID = "prop-pipeline-a";

function seedListing(sub = createDefaultListingSubmission()): void {
  const property: MockProperty = {
    id: PID,
    title: "Pipeline House",
    tagline: "Test",
    address: "1 Test St, Seattle, WA",
    zip: "98101",
    neighborhood: "Test",
    beds: 3,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Pipeline House",
    unitLabel: "3 rooms",
    adminPublishLive: true,
    managerUserId: "mgr-pipeline",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

function renderStep(step: number, form = {}) {
  const noop = () => {};
  return render(
    <RentalWizardStepBody
      step={step}
      form={{ ...createInitialRentalWizardState(), propertyId: PID, ...form }}
      errors={{}}
      mode="public"
      propertyOptions={[{ value: PID, label: "Pipeline House" }]}
      propertyLocked
      patch={noop}
      applicationFeeGate={undefined as unknown as WizardStepsProps["applicationFeeGate"]}
      occupancySyncEpoch={0}
      showAvailabilityWarnings={false}
      setPhone={noop}
      setLandlordPhone={noop}
      setPrevLandlordPhone={noop}
      setSupervisorPhone={noop}
      setRef1Phone={noop}
      setRef2Phone={noop}
      setSsn={noop}
      goToStep={noop}
      editFromReview={noop}
    />,
  );
}

beforeEach(() => {
  const sub = createDefaultListingSubmission();
  sub.allowedLeaseTerms = ["12-Month", "Month-to-Month"];
  seedListing(sub);
});
afterEach(() => cleanup());

describe("the application opens with the lease question", () => {
  it("names step 1 'Which lease are you applying for?' and puts the lease choice before every household question", () => {
    expect(RENTAL_WIZARD_STEP_TITLES[0]).toBe("Which lease are you applying for?");
    const { container } = renderStep(1);
    const step = container.querySelector(".rental-wizard-step");
    expect(step).toBeTruthy();
    const first = step!.firstElementChild!;
    expect(first.hasAttribute("data-wizard-lease-choice")).toBe(true);
    // The lease type is asked here, and the household rows come after it.
    expect(first.querySelector('[data-wizard-field="leaseTerm"]')).toBeTruthy();
    const household = container.querySelector('[data-wizard-field="applyingAsGroup"]');
    if (household) {
      expect(first.compareDocumentPosition(household) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("no longer asks for the property, lease type or room on the dates step", () => {
    const { container } = renderStep(3);
    expect(container.querySelector('[data-wizard-field="propertyId"]')).toBeNull();
    expect(container.querySelector('[data-wizard-field="leaseTerm"]')).toBeNull();
    expect(container.querySelector('[data-wizard-field="roomChoice1"]')).toBeNull();
    expect(container.textContent).toContain("Lease start date");
  });

  it("a link from a listing arrives preselected: the property is shown locked and the carried lease type is selected", () => {
    const { container, getAllByText } = renderStep(1, { leaseTerm: "Month-to-Month" });
    expect(getAllByText("Pipeline House").length).toBeGreaterThan(0);
    // The carried Month-to-Month term reads as Long-term with the Month-to-month length.
    expect(container.textContent).toContain("Long-term");
    expect(container.textContent).toContain("Month-to-month");
    expect(container.textContent).not.toContain("Loading property");
  });

  it("step 1 refuses to continue without a lease type (and a property), step 3 no longer owns them", () => {
    const blank = { ...createInitialRentalWizardState(), applyingAsGroup: "no" as const, hasCosigner: "no" as const };
    const errors = validateRentalWizardStep(1, blank);
    expect(hasLeaseChoiceError(errors)).toBe(true);
    expect(errors.propertyId).toBeTruthy();
    expect(errors.leaseTerm).toBeTruthy();
    const chosen = { ...blank, propertyId: PID, leaseTerm: "Month-to-Month", roomChoice1: PID };
    expect(hasLeaseChoiceError(validateRentalWizardStep(1, chosen))).toBe(false);
  });
});

describe("the fee follows the chosen lease type (one resolver)", () => {
  const sub = normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
  const room = {
    id: "room-1",
    name: "Room 1",
    occupancyPrices: [{ count: 1, applicationFee: "$50" }],
    termPricing: { "Month-to-Month": { applicationFee: "$30" }, "Short-Term Stay": { applicationFee: "$0" } },
  } as unknown as ManagerRoomSubmission;

  it("charges each lease type its own application fee, and a free stay type is a real 0", () => {
    const fee = (leaseTerm: string) =>
      placementApplicationFeeCents(sub, placementFeeOptionsFor(sub, { room, leaseTerm }));
    expect(fee("Long-term")).toBe(5000);
    expect(fee("Month-to-Month")).toBe(3000);
    expect(fee("Short-Term Stay")).toBe(0);
  });
});

describe("approving an application picks the lease from its lease type", () => {
  const published = {
    version: 1,
    disabledStandardApplicationKeys: [],
    customApplicationFields: [],
    applicationConfigMode: "standard",
  } as unknown as ApplicationTemplateQuestionConfig;
  const lease = (label: string, terms: string[]) =>
    ({ ...createPropertyLeaseTemplate({ kind: "long-term", label, source: "axis_default" }), applicationLeaseTerms: terms }) as PropertyLeaseTemplate;
  const form = (label: string, extra: Partial<PropertyApplicationTemplate> = {}) =>
    ({ ...createPropertyApplicationTemplate({ kind: "long-term", label }), publishedQuestionConfig: published, ...extra }) as PropertyApplicationTemplate;

  const longLease = lease("Long-term lease", ["Long-term"]);
  const mtmLease = lease("Month-to-month lease", ["Month-to-Month"]);
  const longForm = form("Standard application", { linkedLeaseTemplateId: longLease.id });
  const mtmForm = form("Month-to-month application", { linkedLeaseTemplateId: mtmLease.id });
  const sub = normalizeManagerListingSubmissionV1({
    ...createDefaultListingSubmission(),
    propertyLeaseTemplates: [longLease, mtmLease],
    propertyApplicationTemplates: [longForm, mtmForm],
  });

  it("the lease type picks the application form mapped to its lease", () => {
    expect(applicationPinForStayTerm(sub, "Month-to-Month")?.templateId).toBe(mtmForm.id);
    expect(applicationPinForStayTerm(sub, "Long-term")?.templateId).toBe(longForm.id);
    expect(applicationPinForStayTerm(sub, "Custom")).toBeNull();
    expect(applicationPinForStayTerm(sub, "")).toBeNull();
  });

  it("an unpublished form is never pinned", () => {
    const draftOnly = normalizeManagerListingSubmissionV1({
      ...sub,
      propertyApplicationTemplates: [longForm, { ...mtmForm, publishedQuestionConfig: undefined }],
    });
    expect(applicationPinForStayTerm(draftOnly, "Month-to-Month")).toBeNull();
  });

  it("approval resolves the lease through the application form's mapping", () => {
    const application = { leaseTerm: "Month-to-Month", rentalType: "standard" as const, applicationTemplateId: mtmForm.id };
    expect(resolvePropertyLeaseTemplateForApplication(sub, application)?.id).toBe(mtmLease.id);
    expect(leaseTemplateIdForApplication(sub, application)).toBe(mtmLease.id);
    expect(leaseTemplateIdForApplication(sub, { ...application, leaseTerm: "Long-term", applicationTemplateId: longForm.id })).toBe(longLease.id);
  });

  it("an application with no mapped form falls back to its lease type's own lease", () => {
    const application = { leaseTerm: "Month-to-Month", rentalType: "standard" as const, applicationTemplateId: undefined };
    expect(leaseTemplateIdForApplication(sub, application)).toBe(mtmLease.id);
  });

  it("Send lease opens on the mapped lease and the manager can still pick another", () => {
    const application = { leaseTerm: "Month-to-Month", rentalType: "standard" as const, applicationTemplateId: mtmForm.id };
    const choices = listLeaseTemplateGenerateChoices(sub, application);
    expect(choices[0]!.template.id).toBe(mtmLease.id);
    expect(choices.map((c) => c.template.id)).toContain(longLease.id);
    // Choosing the other lease by hand pins it for generation.
    const manual = submissionWithLeaseTemplateById(sub, longLease.id);
    expect(readPropertyLeaseTemplates(manual)[0]!.id).toBe(longLease.id);
    expect(readPropertyLeaseTemplates(submissionWithLeaseTemplateForApplication(sub, application))[0]!.id).toBe(mtmLease.id);
    void readPropertyApplicationTemplates;
  });
});

describe("application before a tour: only the workspace setting decides", () => {
  const live = { publishedQuestionConfig: { version: 1 } } as unknown as PropertyApplicationTemplate;
  const formWith = (tourOrder?: string) =>
    ({ ...live, formVariant: "standard", tourOrder }) as unknown as PropertyApplicationTemplate;

  it("normalises anything unknown to the workspace setting", () => {
    expect(normalizeApplicationTourOrder("before_tour")).toBe("before_tour");
    expect(normalizeApplicationTourOrder("after_tour")).toBe("after_tour");
    expect(normalizeApplicationTourOrder("whatever")).toBe("workspace");
    expect(normalizeApplicationTourOrder(undefined)).toBe("workspace");
  });

  it("a form's stored tour order (written before the rule) is ignored: the workspace setting alone answers", () => {
    expect(formRequiresApplicationBeforeTour({ tourOrder: "before_tour" }, "not_needed")).toBe(false);
    expect(formRequiresApplicationBeforeTour({ tourOrder: "after_tour" }, "required")).toBe(true);
    expect(formRequiresApplicationBeforeTour({ tourOrder: "workspace" }, "required")).toBe(true);
    expect(formRequiresApplicationBeforeTour({}, "not_needed")).toBe(false);
  });

  it("the property follows the workspace whatever its forms store", () => {
    expect(applicationBeforeTourRequired("required", [])).toBe(true);
    expect(applicationBeforeTourRequired("not_needed", [])).toBe(false);
    expect(applicationBeforeTourRequired("not_needed", [formWith("before_tour")])).toBe(false);
    expect(applicationBeforeTourRequired("required", [formWith("after_tour")])).toBe(true);
    expect(applicationBeforeTourRequired("required", [formWith("after_tour"), formWith(undefined)])).toBe(true);
    expect(applicationBeforeTourRequired("not_needed", [{ ...formWith("before_tour"), formVariant: "cosigner" } as PropertyApplicationTemplate])).toBe(false);
  });

  describe("server gate", () => {
    let pipelineRow: Record<string, unknown> | null;
    let propertyData: Record<string, unknown> | null;
    let applicationRows: { row_data: unknown }[];

    function fakeDb() {
      return {
        from(table: string) {
          const builder: Record<string, unknown> = {
            select: () => builder,
            eq: () => builder,
            maybeSingle: async () => {
              if (table === "manager_property_records") {
                return { data: { manager_user_id: "owner-1", property_data: propertyData }, error: null };
              }
              if (table === "manager_automation_settings") return { data: pipelineRow ? { row_data: pipelineRow } : null, error: null };
              return { data: null, error: null };
            },
            then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
              return Promise.resolve({ data: table === "manager_application_records" ? applicationRows : [], error: null }).then(resolve);
            },
          };
          return builder;
        },
      } as never;
    }
    const withForms = (...forms: unknown[]) => ({ listingSubmission: { propertyApplicationTemplates: forms } });
    const ask = () => resolveApplicationBeforeTour(fakeDb(), { propertyId: "prop-1", verifiedEmail: "p@example.com" });

    beforeEach(() => {
      pipelineRow = { leasingPipeline: { applicationBeforeTour: "not_needed" } };
      propertyData = null;
      applicationRows = [];
    });

    it("workspace required: the tour is gated until a submitted application exists", async () => {
      pipelineRow = { leasingPipeline: { applicationBeforeTour: "required" } };
      propertyData = withForms(formWith("workspace"));
      expect(await ask()).toMatchObject({ required: true, hasApplication: false });
      expect(await applicationBeforeTourRefusal(fakeDb(), { propertyId: "prop-1", verifiedEmail: "p@example.com" })).toMatch(/application before a tour/i);
      applicationRows = [{ row_data: { stage: "Submitted", propertyId: "prop-1" } }];
      expect(await ask()).toMatchObject({ required: true, hasApplication: true });
      expect(await applicationBeforeTourRefusal(fakeDb(), { propertyId: "prop-1", verifiedEmail: "p@example.com" })).toBeNull();
    });

    it("a form's stored tour order is ignored by the server gate, both ways", async () => {
      propertyData = withForms(formWith("before_tour"));
      expect(await ask()).toEqual({ required: false });
      pipelineRow = { leasingPipeline: { applicationBeforeTour: "required" } };
      propertyData = withForms(formWith("after_tour"));
      expect(await ask()).toMatchObject({ required: true, hasApplication: false });
    });

    it("a form on 'use the workspace setting' follows it both ways", async () => {
      propertyData = withForms(formWith("workspace"));
      expect(await ask()).toEqual({ required: false });
      pipelineRow = { leasingPipeline: { applicationBeforeTour: "required" } };
      expect(await ask()).toMatchObject({ required: true });
    });

    it("no forms on the property: only the workspace setting decides, as before", async () => {
      expect(await ask()).toEqual({ required: false });
      pipelineRow = { leasingPipeline: { applicationBeforeTour: "required" } };
      expect(await ask()).toMatchObject({ required: true, hasApplication: false });
    });
  });
});
