import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
describe("Communication status and action parity", () => {
  it.each(["pro-unified-inbox", "resident-communication", "vendor-communication"])("%s uses row actions without rails or bulk bars", (name) => {
    const source = read(`src/components/portal/${name}.tsx`);
    expect(source).not.toContain("<InboxListSegmentRail");
    expect(source).not.toContain("<CommunicationListBulkBar");
    expect(source).toContain("<CommunicationRowActions row={row}");
  });
  it("shares status choices across manager, resident and vendor", () => {
    const fields = read("src/components/portal/communication-status-filter.tsx");
    for (const label of ["All conversations", "Read", "Unread", "Archived"]) expect(fields).toContain(`label: "${label}"`);
    expect(read("src/components/portal/communication-filter-sort-fields.tsx")).toContain("<CommunicationStatusFilter");
    expect(read("src/components/portal/communication-filter-sort-fields.tsx")).toContain("hideArchived");
    expect(read("src/components/portal/pro-communication.tsx")).toContain("hideArchived");
    for (const role of ["resident", "vendor"]) expect(read(`src/components/portal/${role}-communication.tsx`)).toContain("<CommunicationStatusFilterDraft");
  });

  it("manager Communication list header is one flat block (work boxes, Active|Archived tabs, search line) with slim rows", () => {
    const unified = read("src/components/portal/pro-unified-inbox.tsx");
    const ui = read("src/components/portal/portal-inbox-ui.tsx");
    expect(unified).toContain('data-attr="communication-list-header-card"');
    expect(unified).toContain("<ManagerWorkNumberCard />");
    expect(unified).toContain("<InboxListHeader");
    expect(unified).toContain('layout="inline"');
    // No outer card around the list header: the three panes sit flat on the page.
    expect(unified).not.toContain("rounded-2xl border border-border bg-card shadow-sm");
    expect(unified).toContain('panes="flat"');
    expect(ui).toContain('data-attr="communication-list-tabs"');
    expect(unified).toContain('listVariant="manager"');
    expect(unified).not.toMatch(/InboxConversationRow[\s\S]*address=\{row\.address\}/);
    expect(unified).not.toMatch(/InboxConversationRow[\s\S]*category=\{row\.category\}/);
  });

  it("vendor and resident Communication match manager's Active|Archived tab UI (captain, 2026-09-26 / 2026-10-03)", () => {
    const vendor = read("src/components/portal/vendor-communication.tsx");
    const manager = read("src/components/portal/pro-communication.tsx");
    const resident = read("src/components/portal/resident-communication.tsx");
    // Vendor now hides Archived from its own status filter, exactly like manager.
    expect(vendor).toContain("<CommunicationStatusFilterDraft value={status} onChange={setStatus} hideArchived");
    // Resident follows the same shape (captain 2026-10-03): the tab owns Archived.
    expect(resident).toContain("<CommunicationStatusFilterDraft value={status} onChange={setStatus} hideArchived");
    // Vendor, resident and manager own the tab as instant client state.
    for (const source of [vendor, manager, resident]) {
      expect(source).toContain("useCommunicationListSegment");
      expect(source).toContain("selectCommunicationSegmentUrl");
    }
    // The tab itself intercepts a plain click instead of a full navigation.
    expect(vendor).toContain("interceptNavigation={Boolean(onSegmentChange)}");
    expect(resident).toContain("interceptNavigation={Boolean(onSegmentChange)}");
  });
});
