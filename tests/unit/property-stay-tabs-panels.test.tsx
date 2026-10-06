// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/pro-property-application-questions-panel";
import { ManagerPropertyLeasePanel } from "@/components/portal/pro-property-lease-panel";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  createPropertyApplicationTemplate,
  withApplicationAppliesTo,
  withApplicationDefaultForStay,
  withPropertyApplicationTemplatesExplicit,
} from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate, withLeaseDefaultForStay } from "@/lib/property-lease-templates";

vi.mock("@/components/portal/pro-application-questions-editor-modal", () => ({
  ManagerApplicationQuestionsEditorModal: () => null,
}));
vi.mock("@/components/portal/property-lease-form-modal", () => ({ PropertyLeaseFormModal: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/portal/properties/all/mgr-house-1/application",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => cleanup());

const longOnly = { allowedLeaseTerms: ["Long-term"], shortTermRentalsAllowed: false, airbnbRentalsAllowed: false };
const bothStays = { allowedLeaseTerms: ["Long-term", "Short-Term Stay"], shortTermRentalsAllowed: true, airbnbRentalsAllowed: false };

const both = createPropertyApplicationTemplate({ kind: "long-term", label: "Standard application" });
const longApp = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
const cosigner = createPropertyApplicationTemplate({ kind: "long-term", label: "Co-signer application", formVariant: "cosigner" });
const shortApp = createPropertyApplicationTemplate({ kind: "short-term", label: "Short-term application", formVariant: "short_term" });

function appSub(stays: typeof longOnly, rows = [both, longApp, cosigner, shortApp]) {
  const withBoth = withApplicationAppliesTo(rows, both.id, "both");
  return withPropertyApplicationTemplatesExplicit({ ...createDefaultListingSubmission(), ...stays }, withBoth);
}

function renderApps(sub: ReturnType<typeof createDefaultListingSubmission>) {
  return render(
    <ManagerPropertyApplicationQuestionsPanel
      sub={sub}
      saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
      managerUserId="mgr-1"
      settingsPropertyId="mgr-house-1"
      onUpdated={() => {}}
      showToast={() => {}}
    />,
  );
}

const appRowIds = () =>
  Array.from(document.querySelectorAll('[data-attr^="property-application-row-"]')).map((row) =>
    row.getAttribute("data-attr")!.replace("property-application-row-", ""),
  );

describe("Applications tabs", () => {
  it("an application for both stays is the same record in both tabs; co-signer sits under Long term only", () => {
    renderApps(appSub(bothStays));
    expect(screen.getByRole("button", { name: /^Short term/ })).toBeTruthy();
    expect(appRowIds().sort()).toEqual([both.id, longApp.id, cosigner.id].sort());

    fireEvent.click(screen.getByRole("button", { name: /^Short term/ }));
    expect(appRowIds().sort()).toEqual([both.id, shortApp.id].sort());
    expect(appRowIds()).not.toContain(cosigner.id);
  });

  it("hides the Short term tab on a long-term-only property with no short-term application, keeps it when one exists", () => {
    const withoutShort = appSub(longOnly, [both, longApp, cosigner]);
    renderApps(withoutShort);
    expect(screen.queryByRole("button", { name: /^Short term/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Long term/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Default/ })).toBeTruthy();
    cleanup();

    // Never hide data: the short-term application keeps its tab even though short stays are off.
    renderApps(appSub(longOnly));
    expect(screen.getByRole("button", { name: /^Short term/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Short term/ }));
    expect(appRowIds()).toContain(shortApp.id);
  });

  it("Default tab lists one row per allowed stay with the application that is its default", () => {
    const rows = withApplicationDefaultForStay([both, longApp, cosigner, shortApp], longApp.id, "long_term");
    renderApps(appSub(bothStays, rows));
    fireEvent.click(screen.getByRole("button", { name: /^Default/ }));
    const longRow = document.querySelector('[data-attr="property-application-default-long_term"]')!;
    const shortRow = document.querySelector('[data-attr="property-application-default-short_term"]')!;
    expect(longRow.textContent).toContain("Long-term default");
    expect(longRow.textContent).toContain("Long-term application");
    expect(shortRow.textContent).toContain("Short-term default");
    expect(appRowIds()).toEqual([]);
    expect(document.querySelector('[data-attr="property-application-quick-add"]')).toBeNull();
  });

  it("a long-term-only property's Default tab has the long-term row only", () => {
    renderApps(appSub(longOnly, [both, longApp, cosigner]));
    fireEvent.click(screen.getByRole("button", { name: /^Default/ }));
    expect(document.querySelector('[data-attr="property-application-default-long_term"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="property-application-default-short_term"]')).toBeNull();
  });
});

describe("Leases tabs", () => {
  const longLease = createPropertyLeaseTemplate({ kind: "long-term", label: "Long-term lease", source: "axis_default" });
  const shortLease = createPropertyLeaseTemplate({ kind: "short-term", label: "Short-term lease", source: "axis_default" });

  function renderLeases(stays: typeof longOnly, leases = [longLease, shortLease]) {
    return render(
      <AppUiProvider>
        <ManagerPropertyLeasePanel
          sub={{ ...createDefaultListingSubmission(), ...stays, propertyLeaseTemplates: leases }}
          saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
          managerUserId="mgr-1"
          settingsPropertyId="mgr-house-1"
          onUpdated={() => {}}
          showToast={() => {}}
        />
      </AppUiProvider>,
    );
  }
  const leaseRowIds = () =>
    Array.from(document.querySelectorAll('[data-attr^="property-lease-row-"]')).map((row) =>
      row.getAttribute("data-attr")!.replace("property-lease-row-", ""),
    );

  it("splits leases by stay and lists each stay's default on the Default tab", () => {
    const leases = withLeaseDefaultForStay([longLease, shortLease], shortLease.id, "short_term");
    renderLeases(bothStays, leases);
    expect(leaseRowIds()).toEqual([longLease.id]);
    fireEvent.click(screen.getByRole("button", { name: /^Short-term leases/ }));
    expect(leaseRowIds()).toEqual([shortLease.id]);
    fireEvent.click(screen.getByRole("button", { name: /^Default/ }));
    expect(leaseRowIds()).toEqual([]);
    expect(document.querySelector('[data-attr="property-lease-default-long_term"]')!.textContent).toContain("Long-term lease");
    expect(document.querySelector('[data-attr="property-lease-default-short_term"]')!.textContent).toContain("Short-term lease");
  });

  it("hides the Short-term leases tab when short stays are off and no short-term lease exists", () => {
    renderLeases(longOnly, [longLease]);
    expect(screen.queryByRole("button", { name: /^Short-term leases/ })).toBeNull();
    cleanup();
    renderLeases(longOnly, [longLease, shortLease]);
    expect(screen.getByRole("button", { name: /^Short-term leases/ })).toBeTruthy();
  });
});
