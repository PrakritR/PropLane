import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A list row is tile · title · place line · glyph facts · figure · ⋯ — never a
 * pill. The tab already says the bucket (Approved, Pending, Signed, Paid), and
 * anything else a row must say is plain fact text with a glyph
 * (PLAN-0920-0436; AGENTS.md → Portal UI system → "No pills on rows").
 *
 * This reads the source of every list-row component so a `<Badge` or a status
 * chip cannot creep back onto a row. Detail pages, settings panels and admin
 * tables are not list rows and are not listed here.
 */
const LIST_ROW_SOURCES = [
  "src/components/portal/portal-record-row.tsx",
  "src/components/portal/pro-applications-grouped-table.tsx",
  "src/components/portal/pro-leases-grouped-table.tsx",
  "src/components/portal/inspections-panel.tsx",
  "src/components/portal/pro-payments-ledger-panel.tsx",
  "src/components/portal/pro-outgoing-payments-panel.tsx",
  "src/components/portal/pro-house-properties-panel.tsx",
  "src/components/portal/pro-residents-grouped-table.tsx",
  "src/components/portal/pro-tours-grouped-table.tsx",
  "src/components/portal/bookings-list-panel.tsx",
  "src/components/portal/manager-bookings-list-view.tsx",
  "src/components/portal/pro-vendors-panel.tsx",
  "src/components/portal/pro-task-list.tsx",
  "src/components/portal/pro-work-orders-panel.tsx",
  "src/components/portal/application-household-list.tsx",
  "src/components/portal/application-review-nav-cluster.tsx",
  "src/components/portal/resident-inspection-next-steps.tsx",
  "src/components/portal/vendor-documents-panel.tsx",
  "src/components/portal/vendor-finances-panel.tsx",
  "src/components/portal/portal-payouts-panel.tsx",
];

const PILL_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "<Badge", re: /<Badge\b/ },
  { label: "PortalRowStatusChip", re: /PortalRowStatusChip/ },
];

describe("portal list rows draw no pills", () => {
  for (const file of LIST_ROW_SOURCES) {
    it(`${file} has no Badge or status chip`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const hits = PILL_PATTERNS.filter((p) => p.re.test(source)).map((p) => p.label);
      expect(hits, `${file} draws ${hits.join(", ")} on a list row`).toEqual([]);
    });
  }
});
