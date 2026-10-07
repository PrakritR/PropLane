// Row anatomy guard for the vendor Reviews, Payments and Quick replies lists
// (vendor-portal-redesign-1006): shared rows only — tile · title · place · glyph
// facts · figure · one ⋯ — with no pills and no button rows under a row; every
// utility in a band is an icon.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const LISTS = [
  "src/components/portal/vendor-reviews-panel.tsx",
  "src/components/portal/vendor-quick-replies-settings.tsx",
] as const;

describe("vendor redesign lists", () => {
  it.each(LISTS)("%s draws rows with the shared record row and one ⋯, never a pill or a button row", (file) => {
    const src = read(file);
    expect(src).toContain("PortalPropertyRecordRow");
    expect(src).toContain("VendorRowMenu");
    expect(src).not.toMatch(/<Badge\b/);
    expect(src).not.toMatch(/PortalTableDetailActions|PORTAL_DETAIL_BTN/);
    expect(src).not.toContain("<table");
  });

  it("Payments rows are the shared row with the ⋯ menu, with no expanded button rows", () => {
    const src = read("src/components/portal/vendor-finances-panel.tsx");
    const table = src.slice(src.indexOf("function VendorPaymentsTable"), src.indexOf("type InvoiceFormLine"));
    expect(table).toContain("PortalPropertyRecordRow");
    expect(table).toContain("VendorRowMenu");
    expect(table).not.toMatch(/<Badge\b|<Button\b|<table/);
  });

  it("the Reviews band's utilities are icon actions (filter + gear), and there is exactly one stats strip with the four figures", () => {
    const src = read("src/components/portal/vendor-reviews-panel.tsx");
    expect(src).toContain("VendorSettingsGear");
    for (const label of ["Average rating", "Reviews", "Needs reply", "Response rate"]) expect(src).toContain(`"${label}"`);
  });

  it("the composer ⚡ is the shared QuickReplyMenu, and the menu is reusable by the bid note", () => {
    const inbox = read("src/components/portal/vendor-inbox-panel.tsx");
    expect(inbox).toContain('<QuickReplyMenu');
    expect(inbox).toContain('variant="composer"');
    const menu = read("src/components/portal/quick-reply-menu.tsx");
    expect(menu).toMatch(/export function QuickReplyMenu/);
    expect(menu).toContain("onPick");
  });

  it("the Reviews stats card sits ABOVE the tabs bar (like the balance card on Payments), so it stays put whichever tab is selected", () => {
    const src = read("src/components/portal/vendor-reviews-panel.tsx");
    const render = src.slice(src.indexOf("return (\n    <ManagerPortalPageShell"));
    expect(render.indexOf("<ReviewStatsStrip")).toBeGreaterThan(-1);
    expect(render.indexOf("<ReviewStatsStrip")).toBeLessThan(render.indexOf("<PortalListControlStack"));
    const pay = read("src/components/portal/vendor-finances-panel.tsx");
    expect(pay.indexOf("{above}")).toBeLessThan(pay.indexOf("<PortalListControlStack"));
  });

  it("Trades & service area is one settings-kit card of two rows: no section subheads, no checkbox grid, Trades is a multi-select dropdown", () => {
    const src = read("src/components/portal/vendor-business-settings.tsx");
    const pane = src.slice(src.indexOf("export function VendorTradesServiceAreaPane"), src.indexOf("const LICENSE_FIELDS"));
    expect(pane.match(/<PortalSettingsGroup>/g)).toHaveLength(1);
    expect(pane.match(/<PortalSettingsRow label=/g)).toHaveLength(2);
    expect(pane).toContain("<CheckboxMultiSelect");
    expect(pane).not.toMatch(/PortalSettingsSection|type="checkbox"|data-vs-trades-grid/);
    const panel = read("src/components/portal/vendor-settings-panel.tsx");
    expect(panel).not.toContain('title="Trades"');
    expect(panel).not.toMatch(/VENDOR_TRADE_OPTIONS\.map/);
  });
});
