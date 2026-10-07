/**
 * Captain order: "remove useless buttons, especially if they don't belong in
 * that section". Each control listed in `tests/fixtures/portal-control-removals.json`
 * is gone from its screen; the capability it carried still lives where the
 * entry's `capabilityNowAt` says. These are source-level pins so a removed
 * button cannot quietly come back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordSections } from "@/lib/portals/record-sections";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ids = (role: string, kind: string, section?: string) =>
  recordSections(role as never, kind, { basePath: role === "manager" ? "/portal" : `/${role}` }, section).headerActions.map((a) => a.id);

describe("portal-control-removals fixture", () => {
  const entries = JSON.parse(read("tests/fixtures/portal-control-removals.json")) as Array<Record<string, unknown>>;

  it("is a flat array of fully described removals", () => {
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(["manager", "resident", "vendor"]).toContain(entry.portal);
      for (const key of ["control", "where", "reason", "capabilityNowAt"]) {
        expect(typeof entry[key], `${key} on ${JSON.stringify(entry)}`).toBe("string");
        expect((entry[key] as string).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("user-facing control names never say work order", () => {
    for (const entry of entries) expect(String(entry.control)).not.toMatch(/work order/i);
  });
});

describe("record header registries no longer list removed actions", () => {
  it("vendor record header drops Text, keeps Message", () => {
    const actions = ids("manager", "vendor");
    expect(actions).not.toContain("text");
    expect(actions).toContain("message");
  });

  it("vendor catalog header drops Email and Share, keeps Add", () => {
    const actions = ids("manager", "vendorCatalog");
    expect(actions).not.toContain("email");
    expect(actions).not.toContain("share");
    expect(actions).toContain("add");
  });

  it("vendor bill header drops Message vendor", () => {
    const actions = ids("manager", "vendor-bill");
    expect(actions).not.toContain("message");
    expect(actions).toEqual(expect.arrayContaining(["view-invoice", "schedule", "mark-paid", "delete"]));
  });

  it("manager payment header drops the settings gear and Download", () => {
    const actions = ids("manager", "payment");
    expect(actions).not.toContain("payment-settings");
    expect(actions).not.toContain("download");
  });

  it("resident payment, application and lease registries drop the message / receipt duplicates", () => {
    expect(ids("resident", "payment")).not.toContain("download-receipt");
    expect(ids("resident", "application")).not.toContain("message");
    expect(ids("resident", "lease", "lease-document")).not.toContain("ask");
    expect(ids("resident", "lease", "payments")).not.toContain("receipts");
  });
});

describe("removed controls are absent from their panels", () => {
  it("vendors list: no row Text item, no empty-state Add pills, Open Vendors link kept", () => {
    const src = read("src/components/portal/pro-vendors-panel.tsx");
    expect(src).not.toContain("vendor-row-text");
    expect(src).not.toContain("textVendor");
    expect(src).not.toContain("vendors-catalog-empty-add");
    expect(src).not.toContain("vendors-empty-add");
    expect(src).toContain("settings-vendors-empty-open");
    expect(src).not.toMatch(/actionId === "(text|email|share)"/);
  });

  it("outgoing payments: no Message vendor on the bill header or the row ⋯", () => {
    const src = read("src/components/portal/manager-outgoing-invoices-panel.tsx");
    expect(src).not.toContain("Message vendor");
    expect(src).not.toContain("messageVendor");
  });

  it("resident payments: no Message manager button", () => {
    const src = read("src/components/portal/resident-payments-panel.tsx");
    expect(src).not.toContain("Message manager");
    expect(src).not.toContain("resident-payments-message-manager");
    expect(src).not.toContain("openMessageManagerForCharge");
  });

  it("resident dashboard stage card: no Message manager button", () => {
    const src = read("src/components/portal/resident-lifecycle-status-panel.tsx");
    expect(src).not.toContain("Message manager");
    expect(src).not.toMatch(/communication/);
  });

  it("vendor payments row ⋯: no Message the manager", () => {
    const src = read("src/components/portal/vendor-finances-panel.tsx");
    expect(src).not.toMatch(/id: "message"[\s\S]{0,80}Message the manager/);
    expect(src).not.toContain("communication/active?compose=1");
  });

  it("manager payment record: no one-row CSV Download", () => {
    const src = read("src/components/portal/pro-payments-ledger-panel.tsx");
    expect(src).not.toContain('"payment.csv"');
    expect(src).not.toContain('id: "download"');
  });

  it("empty states carry no create pill (the band's round + is the one create control)", () => {
    expect(read("src/components/portal/pro-promotion.tsx")).not.toContain("promotion-list-add");
    expect(read("src/components/portal/pro-document-library.tsx")).not.toContain("documents-list-add");
    const leasing = read("src/components/portal/pro-documents-leasing-tabs.tsx");
    expect(leasing).not.toContain("documents-applications-empty-upload");
    expect(leasing).not.toContain("documents-leases-empty-upload");
    expect(read("src/components/portal/record-section-renderers.tsx")).not.toContain("record-documents-add");
  });

  it("dashboards: no View all link beside the header →", () => {
    for (const file of ["src/components/portal/pro-dashboard.tsx", "src/components/portal/resident-dashboard.tsx"]) {
      const src = read(file);
      expect(src).not.toContain("dashboard-attention-view-all");
      expect(src).not.toContain("View all");
    }
  });

  it("vendor dashboard: no Manage services or Open calendar", () => {
    const src = read("src/components/portal/vendor-dashboard.tsx");
    expect(src).not.toContain("Manage services");
    expect(src).not.toContain("Open calendar");
    expect(src).not.toContain("vendor-dashboard-manage-jobs");
    expect(src).not.toContain("vendor-dashboard-calendar-open");
  });

  it("bookings: the Calendars dropdown is gone and its colour key is a plain legend row", () => {
    const src = read("src/components/portal/pro-bookings.tsx");
    expect(src).not.toContain("portfolio-bookings-link-airbnb");
    expect(src).not.toContain('label="Calendars"');
    expect(src).toContain("BookingsCalendarLegend");
    const timeline = read("src/components/portal/bookings-portfolio-timeline.tsx");
    expect(timeline).toContain('data-attr="bookings-calendar-legend"');
    expect(timeline).not.toContain("BookingsCalendarKey");
  });

  it("calendar: no Share tour links (Tours keeps its own)", () => {
    expect(read("src/components/portal/portal-calendar.tsx")).not.toContain("calendar-share-tour");
    expect(read("src/components/portal/pro-tours.tsx")).toContain("Share tour link");
  });

  it("lease and application records: no header Share, lease edit modal has no share", () => {
    const lease = read("src/components/portal/lease-primary-header-actions.tsx");
    expect(lease).not.toContain("PortalRecordShareLinkButton");
    expect(lease).not.toContain("shareRecordId");
    expect(read("src/components/portal/pro-pipeline-lease-edit-modal.tsx")).not.toContain("resident-lease-share");
    expect(read("src/components/portal/pro-applications.tsx")).not.toContain("application-share");
  });

  it("the lease Export action reads Download with audit trail", () => {
    const lease = read("src/components/portal/lease-primary-header-actions.tsx");
    expect(lease).toContain("Download with audit trail");
    expect(lease).not.toMatch(/"Exporting…" : "Export"/);
  });
});
