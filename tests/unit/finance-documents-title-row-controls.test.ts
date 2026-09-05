import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL_DIR = join(process.cwd(), "src/components/portal");

function portalSource(file: string): string {
  return readFileSync(join(PORTAL_DIR, file), "utf8");
}

describe("Finance and Documents command layout", () => {
  it("keeps Applications and Leases filters in the command strip like Finances", () => {
    const documents = portalSource("pro-documents-panel.tsx");
    const leasingTabs = portalSource("pro-documents-leasing-tabs.tsx");

    expect(documents).toContain("documentsFilterSheet");
    expect(documents).toContain("PortalFilterSortSheet");
    expect(documents).toContain("leasingPropertyFilter");
    expect(documents).toContain("documents-leasing-filter-sheet-open");
    expect(documents).toContain("titleInlineFilter={null}");
    expect(documents).toContain('variant="command"');
    expect(documents).toContain("documentsCommandActions");
    expect(documents).toContain("activeDocumentsFilterChips");
    expect(documents).not.toContain('data-attr="document-upload-open"');
    expect(leasingTabs).not.toContain("<PortalFilterSortSheet");
    expect(leasingTabs).not.toMatch(/LeasingDocumentsPropertyFilter[^F]/);
    expect(leasingTabs).toContain("LeasingDocumentsPropertyFilterFields");
    expect(leasingTabs).toContain("hideColumnHeaders");
    expect(leasingTabs).toContain("<DataList");
    expect(leasingTabs).toContain("documents-applications-list-add");
    expect(leasingTabs).toContain("documents-leases-list-add");
    expect(leasingTabs).toContain("onAddDocument");
    expect(documents).toContain("listHidden");
    expect(documents).toContain("hideFilterChrome");
    expect(documents).toContain("openDocumentUpload");
  });

  it("renders Finance through a flat left nav without search or header Add", () => {
    const finances = portalSource("pro-finances-panel.tsx");
    const bills = portalSource("pro-bills-panel.tsx");
    const bank = portalSource("pro-bank-reconciliation-panel.tsx");
    const distributions = portalSource("pro-owner-distributions-panel.tsx");

    expect(finances).toContain("titleInlineFilter={null}");
    expect(finances).toContain('variant="command"');
    expect(finances).toContain("financesCommandActions");
    expect(finances).not.toContain("finances-search");
    expect(finances).not.toContain('data-attr="finances-add-income"');
    expect(finances).toContain('data-attr="bank-add-statement"');
    expect(finances).toContain("finances-list-add-income");

    expect(bills).not.toContain("<PortalSectionActionRow");
    expect(bank).not.toContain('data-attr="bank-add-account"');
    expect(distributions).not.toContain("<PortalSectionActionRow");
  });

  it("constrains Finance filter sheets away from adjacent portal rails", () => {
    const finances = portalSource("pro-finances-panel.tsx");

    expect(finances).toContain("constrainDropdownToTitleBand");
  });

  it("keeps the Communication filter panel tall enough for four fields", () => {
    const communication = portalSource("pro-communication.tsx");
    const filterFields = portalSource("filter-field-lists.tsx");

    expect(communication).toContain("constrainDropdownToTitleBand");
    expect(filterFields).toContain("PORTAL_FILTER_PANEL_FOUR_FIELD_HEIGHT_CLASS");
  });

  it("uses the Applications command strip for Payments filters and actions", () => {
    const payments = portalSource("pro-payments.tsx");
    const applications = portalSource("pro-applications.tsx");

    expect(payments).toContain("titleInlineFilter={null}");
    expect(payments).toContain('variant="command"');
    expect(payments).toContain("commandStripTrigger");
    expect(payments).toContain("paymentsListActions");
    expect(payments).toContain("paymentsSettingsMenu");
    expect(payments).toContain('data-attr="payments-setup"');
    expect(payments).toMatch(/\n\s+Setup\n/);
    expect(payments).not.toMatch(/paymentsSetupButton[\s\S]*Payment setup/);
    expect(payments).not.toContain("Add charge");
    expect(payments).not.toContain("payments-direction-incoming");
    expect(applications).toContain("titleInlineFilter={null}");
    expect(applications).toContain('variant="command"');
    expect(applications).toContain("applicationsFilterSort");
  });
});
