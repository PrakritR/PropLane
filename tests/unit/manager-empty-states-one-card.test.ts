/**
 * One empty state for every manager list (PLAN-0914-1629). Source guard: no
 * manager list file renders the old generic line, a raw `empty={<p`, or an
 * inline `PortalDataTableEmpty` for its tab body — each passes the card.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL_DIR = join(process.cwd(), "src/components/portal");
const src = (file: string) => readFileSync(join(PORTAL_DIR, file), "utf8");

const MANAGER_LIST_FILES = [
  "pro-house-properties-panel.tsx",
  "pro-tours.tsx",
  "pro-applications.tsx",
  "pro-leases.tsx",
  "pro-leases-pipeline-panel.tsx",
  "pro-residents.tsx",
  "inspections-panel.tsx",
  "pro-payments.tsx",
  "pro-payments-ledger-panel.tsx",
  "pro-outgoing-payments-panel.tsx",
  "pro-all-services-panel.tsx",
  "pro-vendors-panel.tsx",
  "pro-task-list.tsx",
  "manager-bookings-list-view.tsx",
  "bookings-list-panel.tsx",
  "pro-unified-inbox.tsx",
  "pro-promotion.tsx",
  "pro-finances-panel.tsx",
  "pro-documents-leasing-tabs.tsx",
  "pro-document-library.tsx",
];

describe("manager list empty states: one card", () => {
  it("nobody says 'Nothing here yet' or hands the surface a raw paragraph", () => {
    for (const file of MANAGER_LIST_FILES) {
      const s = src(file);
      expect(s, file).not.toContain("Nothing here yet");
      expect(s, file).not.toMatch(/empty=\{\s*<p\b/);
      expect(s, file).not.toContain("<PortalInboxEmptyState");
      expect(s, file).not.toContain("<InboxConversationListAddRow");
    }
    expect(src("portal-record-list-surface.tsx")).not.toContain('"Nothing here yet"');
  });

  it("every manager list reads its title from the copy table or passes the card", () => {
    for (const file of MANAGER_LIST_FILES) {
      const s = src(file);
      expect(s, file).toMatch(/portalEmptyCopy\(|emptyCard=\{|<PortalListEmptyCard/);
    }
  });

  it("the generic empty state renders through the one card", () => {
    const s = src("portal-empty-state.tsx");
    expect(s).toContain("<PortalListEmptyCard");
    expect(s).not.toContain("AxisHeaderMarkTile");
  });
});
