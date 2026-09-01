import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL_DIR = join(process.cwd(), "src/components/portal");

function portalSource(file: string): string {
  return readFileSync(join(PORTAL_DIR, file), "utf8");
}

describe("Finance and Documents command layout", () => {
  it("keeps Applications and Leases free of title-row property filters", () => {
    const documents = portalSource("manager-documents-panel.tsx");
    const leasingTabs = portalSource("manager-documents-leasing-tabs.tsx");

    expect(documents).not.toContain("leasingDocumentsFilterSheet");
    expect(documents).not.toContain("leasingPropertyFilter");
    expect(documents).toContain("titleInlineFilter={null}");
    expect(documents).toContain("DocumentsDestinationNav");
    expect(documents).not.toContain("PortalListControlStack");
    expect(documents).not.toContain("document-search");
    expect(documents).not.toContain('data-attr="document-upload-open"');
    expect(leasingTabs).not.toContain("<PortalFilterSortSheet");
    expect(leasingTabs).toContain("hideColumnHeaders");
    expect(leasingTabs).toContain("<DataList");
  });

  it("renders Finance through a flat left nav without search or header Add", () => {
    const finances = portalSource("manager-finances-panel.tsx");
    const bills = portalSource("manager-bills-panel.tsx");
    const bank = portalSource("manager-bank-reconciliation-panel.tsx");
    const distributions = portalSource("manager-owner-distributions-panel.tsx");

    expect(finances).toContain("FinanceDestinationNav");
    expect(finances).toContain("titleInlineFilter={null}");
    expect(finances).toContain("financesToolbarActions");
    expect(finances).not.toContain("PortalListControlStack");
    expect(finances).not.toContain("finances-search");
    expect(finances).not.toContain('data-attr="finances-add-income"');
    expect(finances).toContain('data-attr="bank-add-statement"');
    expect(finances).toContain("finances-list-add-income");

    expect(bills).not.toContain("<PortalSectionActionRow");
    expect(bank).not.toContain('data-attr="bank-add-account"');
    expect(distributions).not.toContain("<PortalSectionActionRow");
  });

  it("constrains Finance filter sheets away from adjacent portal rails", () => {
    const finances = portalSource("manager-finances-panel.tsx");

    expect(finances).toContain("constrainDropdownToTitleBand");
  });

  it("keeps the Communication filter panel tall enough for four fields", () => {
    const communication = portalSource("manager-communication.tsx");
    const filterFields = portalSource("filter-field-lists.tsx");

    expect(communication).toContain("constrainDropdownToTitleBand");
    expect(filterFields).toContain("PORTAL_FILTER_PANEL_FOUR_FIELD_HEIGHT_CLASS");
  });

  it("uses the Applications command strip for Payments filters and actions", () => {
    const payments = portalSource("manager-payments.tsx");
    const applications = portalSource("manager-applications.tsx");

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
