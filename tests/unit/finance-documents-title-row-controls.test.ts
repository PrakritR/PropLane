import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL_DIR = join(process.cwd(), "src/components/portal");

function portalSource(file: string): string {
  return readFileSync(join(PORTAL_DIR, file), "utf8");
}

describe("Finance and Documents title-row controls", () => {
  it("keeps Applications and Leases free of title-row property filters", () => {
    const documents = portalSource("manager-documents-panel.tsx");
    const leasingTabs = portalSource("manager-documents-leasing-tabs.tsx");

    expect(documents).not.toContain("leasingDocumentsFilterSheet");
    expect(documents).not.toContain("leasingPropertyFilter");
    expect(documents).toContain("titleInlineFilter={documentsInlineFilter}");
    expect(documents).toContain("titleAside={documentsTitleAside}");
    expect(leasingTabs).not.toContain("<PortalFilterSortSheet");
    expect(leasingTabs).toContain("hideColumnHeaders");
    expect(leasingTabs).toContain("<DataList");
  });

  it("renders special Finance actions through the Finance header instead of a body toolbar", () => {
    const finances = portalSource("manager-finances-panel.tsx");
    const bills = portalSource("manager-bills-panel.tsx");
    const bank = portalSource("manager-bank-reconciliation-panel.tsx");
    const distributions = portalSource("manager-owner-distributions-panel.tsx");

    expect(finances).toContain("const financesAddButton =");
    expect(finances).toContain("PortalAdaptiveHeaderActions");
    expect(finances).toContain("titleInlineFilter={financesInlineFilter}");
    expect(finances).toContain("titleAside={financesTitleAside}");
    expect(finances).toContain('data-attr="finances-add-bill"');
    expect(finances).toContain('data-attr="bank-add-account"');
    expect(finances).toContain('data-attr="bank-add-statement"');
    expect(finances).toContain('data-attr="finances-add-distribution"');

    expect(bills).not.toContain("<PortalSectionActionRow");
    expect(bank).not.toContain('data-attr="bank-add-account"');
    expect(bank).not.toContain('data-attr="bank-add-statement"');
    expect(distributions).not.toContain("<PortalSectionActionRow");
  });

  it("constrains both title-row filters away from adjacent portal rails", () => {
    const documents = portalSource("manager-documents-panel.tsx");
    const finances = portalSource("manager-finances-panel.tsx");

    expect(documents).toContain("constrainDropdownToTitleBand");
    expect(finances).toContain("constrainDropdownToTitleBand");
  });

  it("keeps the Communication filter panel tall enough for four fields", () => {
    const communication = portalSource("manager-communication.tsx");
    const filterFields = portalSource("filter-field-lists.tsx");

    expect(communication).toContain("constrainDropdownToTitleBand");
    expect(filterFields).toContain("PORTAL_FILTER_PANEL_FOUR_FIELD_HEIGHT_CLASS");
  });

  it("keeps Payments in the title band while Applications uses the command strip", () => {
    const payments = portalSource("manager-payments.tsx");
    const applications = portalSource("manager-applications.tsx");

    expect(payments).toContain("titleInlineFilter={paymentsFilterSheet}");
    expect(payments).not.toContain('desktopPresentation="inline"');
    expect(applications).toContain("titleInlineFilter={null}");
    expect(applications).toContain('variant="command"');
    expect(applications).toContain("filterRow={applicationsFilterSort}");
  });
});
