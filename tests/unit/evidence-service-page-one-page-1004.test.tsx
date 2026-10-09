// @vitest-environment jsdom
//
// EVIDENCE HARNESS for studio plan claude-1/mobile-step-tabs-1004 § Services:
// the manager service record is ONE page — the rail is Service · Vendors ·
// Incoming payments · Outgoing payments · Communication, there are no
// Details / Photos / Activity sub-tabs, and the header is Message · Edit · ⋯
// plus exactly one labeled next step (Request bids / Schedule / Complete).
//
// Same contract as the other evidence-* harnesses: without EVIDENCE_DIR this is
// a plain render test and writes nothing.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { renderedBodyHtml } from "../helpers/evidence-dom";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string; caption: string }[] = [];
function capture(name: string, caption: string) {
  if (!EVIDENCE_DIR) return;
  captured.push({ name, html: renderedBodyHtml(), caption });
}
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html, caption } of captured) {
    writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
    writeFileSync(join(EVIDENCE_DIR, `${name}.caption.txt`), caption, "utf8");
  }
});

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [], vendors: [] }),
}));
vi.mock("@/lib/manager-vendors-storage", () => ({
  MANAGER_VENDORS_EVENT: "manager-vendors-changed",
  readActiveManagerVendorRows: () => [],
  syncManagerVendorsFromServer: () => Promise.resolve(),
}));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  deleteManagerWorkOrderRow: vi.fn(() => true),
  updateManagerWorkOrder: vi.fn(),
  syncManagerWorkOrdersFromServer: () => Promise.resolve(),
}));

import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerWorkOrdersPanel } from "@/components/portal/pro-work-orders-panel";

afterEach(cleanup);

function row(overrides: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow {
  return {
    id: "wo-1",
    propertyName: "12 Maple St",
    unit: "1A",
    title: "Fix sink",
    priority: "Medium",
    status: "Open",
    bucket: "open",
    description: "Leaking under the sink",
    scheduled: "",
    cost: "",
    ...overrides,
  };
}

function headerIcons() {
  return [...document.querySelectorAll('[data-attr="service-record-header-icons"] button')]
    .filter(b => !b.closest("[inert]"))
    .map(b => b.getAttribute("aria-label"));
}

describe("service record is one page with one labeled next step", () => {
  it("an unassigned open service: one rail, no sub-tabs, Message · Edit · ⋯ · Request bids", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel allRows={[row()]} bucket="open" workOrderId="wo-1" listBasePath="/portal" />
      </AppUiProvider>,
    );
    const rail = screen.getByRole("navigation", { name: "Service sections" });
    expect(within(rail).getAllByRole("link").map(l => l.textContent)).toEqual([
      "Service",
      "Vendors",
      "Incoming payments",
      "Outgoing payments",
      "Communication",
    ]);
    // The retired sub-tabs are gone from the page entirely.
    for (const gone of ["Details", "Photos", "Activity"]) {
      expect(screen.queryByRole("tab", { name: gone })).toBeNull();
      expect(within(rail).queryByText(gone)).toBeNull();
    }
    expect(headerIcons()).toEqual(["Edit", "Remove service", "Request bids"]);
    const primary = document.querySelector('[data-attr="manager-service-primary"]')!;
    expect(primary.textContent).toBe("Request bids");
    capture(
      "service-one-page-open",
      'Manager · a service record — ONE page (rail: Service · Vendors · Incoming payments · Outgoing payments · Communication, no Details/Photos/Activity sub-tabs). Header is Edit · red trash and the single labeled next step, here "Request bids".',
    );
  });

  it("a scheduled service: the same one page, and the next step reads Complete", () => {
    render(
      <AppUiProvider>
        <ManagerWorkOrdersPanel
          allRows={[row({ bucket: "scheduled", scheduled: "Oct 8", vendorId: "v-1", vendorName: "Acme Plumbing", scheduledAtIso: "2026-10-08T16:00:00.000Z" })]}
          bucket="scheduled"
          workOrderId="wo-1"
          listBasePath="/portal"
        />
      </AppUiProvider>,
    );
    const primary = document.querySelector('[data-attr="manager-service-primary"]')!;
    expect(primary.getAttribute("aria-label")).toBe("Complete");
    expect(headerIcons()).toEqual(["Edit", "More", "Remove service", "Complete"]);
    capture(
      "service-one-page-scheduled",
      'Manager · the same service once it is scheduled with a vendor — still one page, and the one labeled header action becomes "Complete".',
    );
  });
});
