// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ContactStep } from "@/components/portal/resident-wizard/step-contact";
import { ReviewStep } from "@/components/portal/resident-wizard/step-review";
import type { ResidentWizardDerived } from "@/components/portal/resident-wizard/derived";
import {
  addPersonFormIsDirty,
  alsoCreates,
  commitCreatesLease,
  commitCreatesPayments,
  currentResidentStepOffPath,
  defaultAlsoCreate,
  emptyAddPersonForm,
  normalizeAlsoCreate,
  thingsToFinish,
} from "@/components/portal/resident-wizard/state";

const derivedStub: ResidentWizardDerived = {
  roomOptions: [],
  bundleOptions: [],
  leaseTermOptions: [],
  leaseTermPresetValues: [],
  rentedByRoom: false,
  entireHome: true,
  showBundleSelect: false,
  showRoomSelect: false,
  rentalType: "standard",
  isShortTerm: false,
  isAirbnb: false,
  isMonthToMonth: false,
  applicationConfig: null,
  customQuestions: [],
  fieldEnabled: () => true,
  listingSays: null,
};

afterEach(() => {
  cleanup();
});

const blankStrip = { kind: "blank" as const };

describe("Also create — current resident", () => {
  it("defaults Lease on for a current resident and nothing for a prospect", () => {
    expect(defaultAlsoCreate("resident")).toEqual(["lease"]);
    expect(defaultAlsoCreate("prospect")).toEqual([]);
    expect(emptyAddPersonForm("resident").alsoCreate).toEqual(["lease"]);
    expect(emptyAddPersonForm("prospect").alsoCreate).toEqual([]);
    expect(addPersonFormIsDirty(emptyAddPersonForm("resident"))).toBe(false);
  });

  it("snaps an empty picker back to Lease and puts Application on-path only when picked", () => {
    expect(normalizeAlsoCreate([])).toEqual(["lease"]);
    expect(normalizeAlsoCreate(["application"])).toEqual(["application"]);
    expect(normalizeAlsoCreate(["lease", "application", "bogus"])).toEqual(["lease", "application"]);

    const leaseOnly = emptyAddPersonForm("resident");
    expect(currentResidentStepOffPath("lease", leaseOnly)).toBe(false);
    expect(currentResidentStepOffPath("application", leaseOnly)).toBe(true);
    expect(currentResidentStepOffPath("payments", leaseOnly)).toBe(true);
    expect(currentResidentStepOffPath("documents", leaseOnly)).toBe(true);
    expect(currentResidentStepOffPath("home", leaseOnly)).toBe(false);

    const withApp = { ...leaseOnly, alsoCreate: normalizeAlsoCreate(["lease", "application"]) };
    expect(alsoCreates(withApp, "application")).toBe(true);
    expect(currentResidentStepOffPath("application", withApp)).toBe(false);
    expect(addPersonFormIsDirty(withApp)).toBe(true);
  });

  it("does not ask for lease fields when Lease is unchecked", () => {
    const noLease = {
      ...emptyAddPersonForm("resident"),
      alsoCreate: normalizeAlsoCreate(["application"]),
    };
    expect(thingsToFinish(noLease).map((t) => t.step)).toEqual(["contact", "contact", "home"]);
    expect(thingsToFinish(noLease).some((t) => t.step === "lease")).toBe(false);
  });

  it("does not write charges unless Also create includes Payments", () => {
    const leaseOnly = emptyAddPersonForm("resident");
    expect(commitCreatesLease(leaseOnly)).toBe(true);
    expect(commitCreatesPayments(leaseOnly)).toBe(false);
    expect(commitCreatesPayments({ ...leaseOnly, alsoCreate: normalizeAlsoCreate(["lease", "payments"]) })).toBe(true);
    expect(commitCreatesLease(emptyAddPersonForm("prospect"))).toBe(false);
    expect(commitCreatesPayments(emptyAddPersonForm("prospect"))).toBe(false);
    const commitSource = readFileSync(resolve(process.cwd(), "src/components/portal/resident-wizard/commit.ts"), "utf8");
    expect(commitSource).toContain("commitCreatesPayments(form)");
    expect(commitSource).toContain("commitCreatesLease(form)");
    expect(commitSource).not.toContain("syncLeasePipelineFromApplications");
    expect(commitSource).toContain("generateLeaseHtmlForRow");
    expect(commitSource).toContain("sendLeaseToResident");
    expect(commitSource).toContain("persist: false");
    expect(commitSource).toContain("sendWelcomeEmail");
    const storageSource = readFileSync(resolve(process.cwd(), "src/lib/manager-applications-storage.ts"), "utf8");
    expect(storageSource).toContain("skipLeaseSeed");
    expect(storageSource).toContain("serverConfirmed: true, skipLeaseSeed: true");
  });

  it("shows Also create on a current resident and not on a prospect, without the old hint sentence", () => {
    const { rerender } = render(
      <ContactStep
        form={emptyAddPersonForm("resident")}
        patch={() => {}}
        strip={blankStrip}
        onPickFile={() => {}}
        onUndoFill={() => {}}
        busy={false}
      />,
    );
    expect(screen.getByText("Also create")).toBeTruthy();
    expect(screen.queryByText(/application · lease · payments · documents/)).toBeNull();
    expect(screen.queryByText(/contact · tour/)).toBeNull();

    rerender(
      <ContactStep
        form={emptyAddPersonForm("prospect")}
        patch={() => {}}
        strip={blankStrip}
        onPickFile={() => {}}
        onUndoFill={() => {}}
        busy={false}
      />,
    );
    expect(screen.queryByText("Also create")).toBeNull();
  });

  it("Review does not preview a payment schedule when Payments is off", () => {
    const form = {
      ...emptyAddPersonForm("resident"),
      name: "Casey Addtest",
      email: "casey.addtest.0918@test.proplane.local",
      leaseTerm: "long_term",
      moveInDate: "2026-10-01",
      rent: "1200",
    };
    render(
      <ReviewStep form={form} patch={() => {}} derived={derivedStub} propertyLabel={null} goTo={() => {}} />,
    );
    const payments = document.querySelector('[data-attr="residents-wizard-review-payments"]');
    expect(payments?.textContent).toContain("Off this add");
    expect(payments?.textContent).not.toContain("$1,200.00/mo from 2026-10-01");
    const application = document.querySelector('[data-attr="residents-wizard-review-application"]');
    expect(application?.textContent).toContain("Off this add");
    const documents = document.querySelector('[data-attr="residents-wizard-review-documents"]');
    expect(documents?.textContent).toContain("Off this add");
    const lease = document.querySelector('[data-attr="residents-wizard-review-lease"]');
    expect(lease?.textContent).toContain("Generate later");
  });

  it("Add resident property picker uses the shared portfolio helper", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/portal/pro-residents.tsx"), "utf8");
    expect(src).toMatch(/const propertyOptions = useMemo\(\(\) => \{[\s\S]*buildManagerPropertyFilterOptions\(userId\)/);
    expect(src).not.toContain("readExtraListingsForUser(userId)");
  });
});
