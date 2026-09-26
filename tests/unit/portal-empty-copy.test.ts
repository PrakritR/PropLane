/**
 * One table of empty-tab titles (PLAN-0914-1629): every tab has one, none
 * says "Nothing here yet", none ends in a full stop, and the sibling helper
 * points at the first other tab that has rows.
 */
import { describe, expect, it } from "vitest";
import {
  PORTAL_EMPTY_COPY,
  portalEmptyNoMatchTitle,
  portalEmptySibling,
  portalEmptyTitleFromAddLabel,
} from "@/lib/portal-empty-copy";

describe("portal empty copy", () => {
  it("every section·tab has a title that names the tab", () => {
    for (const [key, copy] of Object.entries(PORTAL_EMPTY_COPY)) {
      expect(copy.title, key).toMatch(/^(No |Nothing |All caught up)/);
      expect(copy.title, key).not.toMatch(/\.$/);
      expect(copy.title, key).not.toBe("Nothing here yet");
      expect(copy.section, key).toMatch(/^[a-z-]+$/);
    }
  });

  it("covers the tabs the sections actually route", () => {
    for (const key of [
      "properties.all", "properties.drafts", "tours.pending", "applications.rejected", "leases.manager", "leases.completed",
      "residents.past", "inspections.move-out", "payments.paid", "payments.outgoing", "services.open", "services.declined",
      "vendors", "vendors.catalog", "tasks.open", "tasks.completed", "bookings.inhouse", "communication.archived", "promotion", "promotion.text", "promotion.image", "finances.expenses", "documents.other",
      "work-orders.pending", "work-orders.upcoming", "work-orders.past",
      "finances.invoices", "finances.payouts",
    ]) {
      expect(PORTAL_EMPTY_COPY, key).toHaveProperty(key);
    }
  });

  it("no-match titles quote the search or name the filters", () => {
    expect(portalEmptyNoMatchTitle("homes", "paseo")).toBe("No homes match “paseo”");
    expect(portalEmptyNoMatchTitle("homes")).toBe("No homes match these filters");
  });

  it("sibling: the first other tab with rows, or nothing", () => {
    const tabs = [
      { id: "incomplete", label: "Incomplete", count: 0, href: "/a" },
      { id: "pending", label: "Pending", count: 0, href: "/p" },
      { id: "approved", label: "Approved", count: 3, href: "/ap" },
    ];
    expect(portalEmptySibling(tabs, "pending")).toEqual({ label: "3 approved", href: "/ap", onClick: undefined });
    expect(portalEmptySibling(tabs, "approved")).toBeNull();
    expect(portalEmptySibling([{ id: "open", label: "Open", count: 2, onSelect: () => {} }], "done")?.label).toBe("2 open");
  });

  it("C242: drafts names what a draft actually is, not just that there are none", () => {
    // A bare "No drafts" gave a first-time manager no memory jog of what
    // "drafts" even means — this names the concept (an unfinished listing)
    // right in the title, since no sentence is drawn under it.
    expect(PORTAL_EMPTY_COPY["properties.drafts"].title).toBe("No listings in progress");
  });

  it("derives a titled card from a bare add label — never 'Nothing here yet'", () => {
    expect(portalEmptyTitleFromAddLabel("Add lease")).toBe("No leases yet");
    expect(portalEmptyTitleFromAddLabel("Add outgoing payment")).toBe("No outgoing payments yet");
    expect(portalEmptyTitleFromAddLabel("Add service for this resident")).toBe("No services yet");
    expect(portalEmptyTitleFromAddLabel("Schedule tour")).toBe("No tours yet");
    expect(portalEmptyTitleFromAddLabel("Add property")).toBe("No properties yet");
  });
});
