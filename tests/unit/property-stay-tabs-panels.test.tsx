// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/pro-property-application-questions-panel";
import { ManagerPropertyLeasePanel } from "@/components/portal/pro-property-lease-panel";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  createPropertyApplicationTemplate,
  readPropertyApplicationTemplates,
  withApplicationAppliesTo,
  withApplicationDefaultForStay,
  withPropertyApplicationTemplatesExplicit,
} from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate, readPropertyLeaseTemplates, withLeaseDefaultForStay } from "@/lib/property-lease-templates";
import { syncPropertyApplicationTemplatesFromListing } from "@/lib/property-application-template-sync";
import { syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";

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
    cleanup();

    // Never hide data: the short-term application keeps its tab even though short stays are off.
    renderApps(appSub(longOnly));
    expect(screen.getByRole("button", { name: /^Short term/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Short term/ }));
    expect(appRowIds()).toContain(shortApp.id);
  });

  it("an untouched seeded short-term default on a long-term-only property is offered:false and holds no tab", () => {
    const seeded = { ...shortApp, listingSeedKey: "short-term" as const };
    renderApps(appSub(longOnly, [longApp, cosigner, seeded]));
    expect(screen.queryByRole("button", { name: /^Short term/ })).toBeNull();
    expect(appRowIds()).not.toContain(shortApp.id);
    // Kept, never deleted: the sync only switches it off.
    const synced = readPropertyApplicationTemplates(syncPropertyApplicationTemplatesFromListing(appSub(longOnly, [longApp, cosigner, seeded])));
    const kept = synced.find((row) => row.id === shortApp.id);
    expect(kept).toMatchObject({ offered: false, stayHidden: true });
    cleanup();

    // A seeded row the manager renamed is theirs: it keeps the tab.
    renderApps(appSub(longOnly, [longApp, cosigner, { ...seeded, label: "Guest booking form" }]));
    expect(screen.getByRole("button", { name: /^Short term/ })).toBeTruthy();
  });

  it("there is no Default tab; a stay's default is a row marked Default with Set as default on the others", () => {
    const rows = withApplicationDefaultForStay([both, longApp, cosigner, shortApp], longApp.id, "long_term");
    renderApps(appSub(bothStays, rows));
    expect(screen.queryByRole("button", { name: /^Default/ })).toBeNull();
    const defaultRow = document.querySelector(`[data-attr="property-application-row-${longApp.id}"]`)!;
    expect(defaultRow.textContent).toContain("Default");
    expect(document.querySelector(`[data-attr="property-application-row-${both.id}"]`)!.textContent).not.toContain("Default");
    // The default row offers no "Set as default"; every other row offers the open stay's only.
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Long-term application" }), { key: "ArrowDown" });
    expect(screen.queryByRole("menuitem", { name: /Set as default/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Standard application" }), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Set as default for long term" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /default for short term/ })).toBeNull();
  });

  it("an application for both stays can be the default in each tab independently", () => {
    const rows = withApplicationDefaultForStay(
      withApplicationDefaultForStay([both, longApp, cosigner, shortApp], both.id, "long_term"),
      both.id,
      "short_term",
    );
    renderApps(appSub(bothStays, rows));
    expect(document.querySelector(`[data-attr="property-application-row-${both.id}"]`)!.textContent).toContain("Default");
    fireEvent.click(screen.getByRole("button", { name: /^Short term/ }));
    expect(document.querySelector(`[data-attr="property-application-row-${both.id}"]`)!.textContent).toContain("Default");
    expect(document.querySelector(`[data-attr="property-application-row-${shortApp.id}"]`)!.textContent).not.toContain("Default");
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

  it("splits leases by stay, with no Default tab: the stay's default is a marked row", () => {
    const leases = withLeaseDefaultForStay([longLease, shortLease], shortLease.id, "short_term");
    renderLeases(bothStays, leases);
    expect(screen.queryByRole("button", { name: /^Default/ })).toBeNull();
    expect(leaseRowIds()).toEqual([longLease.id]);
    fireEvent.click(screen.getByRole("button", { name: /^Short-term leases/ }));
    expect(leaseRowIds()).toEqual([shortLease.id]);
    expect(document.querySelector(`[data-attr="property-lease-row-${shortLease.id}"]`)!.textContent).toContain("Default");
  });

  it("hides the Short-term leases tab when short stays are off and no short-term lease exists", () => {
    renderLeases(longOnly, [longLease]);
    expect(screen.queryByRole("button", { name: /^Short-term leases/ })).toBeNull();
    cleanup();
    renderLeases(longOnly, [longLease, shortLease]);
    expect(screen.getByRole("button", { name: /^Short-term leases/ })).toBeTruthy();
    cleanup();

    // An untouched seeded short-term default is switched off (kept, not deleted) and holds no tab; a renamed one does.
    const seeded = { ...shortLease, listingSeedKey: "short-term" as const };
    renderLeases(longOnly, [longLease, seeded]);
    expect(screen.queryByRole("button", { name: /^Short-term leases/ })).toBeNull();
    const kept = readPropertyLeaseTemplates(
      syncPropertyLeaseTemplatesFromListing({ ...createDefaultListingSubmission(), ...longOnly, propertyLeaseTemplates: [longLease, seeded] }),
    ).find((row) => row.id === shortLease.id);
    expect(kept).toMatchObject({ offered: false, stayHidden: true });
    cleanup();
    renderLeases(longOnly, [longLease, { ...seeded, label: "Guest stay agreement" }]);
    expect(screen.getByRole("button", { name: /^Short-term leases/ })).toBeTruthy();
  });
});
