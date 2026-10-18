// @vitest-environment jsdom
//
// Reviewer evidence for comanager-number-1015, vendor half: a teammate texts a
// vendor FROM THE WORKSPACE NUMBER, so the vendor record's "Reach them by" row
// reads Text — and only while that teammate may themselves send on the line
// (`canSend`), or the send comes back 403.
//
// Renders the REAL `ManagerVendorDetail` overview. With EVIDENCE_DIR set each
// surface is dumped for tests/browser/teammate-number-1017 to paint.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

import { writeEvidenceSurface } from "../helpers/evidence-dom";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/vendors/v-1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
const messaging = vi.hoisted(() => ({ status: null as Record<string, unknown> | null }));
vi.mock("@/hooks/use-manager-messaging-number-status", () => ({
  useManagerMessagingNumberStatus: () => ({ status: messaging.status }),
}));
vi.mock("@/components/portal/record-communication-section", () => ({
  RecordCommunicationSection: () => <div data-attr="mock-record-communication" />,
}));
vi.mock("@/lib/manager-work-orders-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readManagerWorkOrderRows: () => [],
  syncManagerWorkOrdersFromServer: async () => [],
}));
vi.mock("@/lib/manager-vendor-summary-client", () => ({
  loadManagerVendorSummary: async () => ({
    jobs: [],
    totalJobCount: 0,
    ratingCount: 0,
    ratingAverage: null,
    completedJobCount: 0,
    completedInvoiceTotalCents: null,
    completedInvoiceAverageCents: null,
  }),
  invalidateManagerVendorSummary: () => {},
}));

import { ManagerVendorDetail } from "@/components/portal/pro-vendor-detail";

const vendor = (): ManagerVendorRow => ({
  id: "v-1",
  managerUserId: "mgr-1",
  name: "Pacific Plumbing",
  trade: "Plumbing",
  phone: "206-555-0100",
  email: "hello@pacific.test",
  notes: "Same-day for burst pipes.",
  active: true,
});

/** The teammate's status: the line is the owner's, read off `workspaceNumber`. */
const workspaceLine = (over: Record<string, unknown>) => ({
  workspaceRole: "co_manager",
  workspaceNumber: { phoneNumber: "+12065550199", ownerUserId: "owner-1", ownerName: "Dana Reyes" },
  number: null,
  sendingAvailable: true,
  lineReady: true,
  ...over,
});

beforeEach(() => {
  messaging.status = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      const body = u.startsWith("/api/manager/vendor-invoices?status")
        ? { invoices: [], payouts: [], totals: { owedCents: 0, paidThisYearCents: 0 } }
        : u.startsWith("/api/portal/vendor-reviews")
          ? { reviews: [], aggregate: { average: null, count: 0 } }
          : u.startsWith("/api/portal/work-order-bids")
            ? { bids: [] }
            : u.startsWith("/api/portal/work-order-vendor-offers")
              ? { offers: [] }
              : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderOverview = () =>
  render(
    <AppUiProvider>
      <ManagerVendorDetail row={vendor()} managerUserId="mgr-1" onNavigate={vi.fn()} tab="overview" />
    </AppUiProvider>,
  );

const reachRow = async () => {
  const label = await waitFor(() => screen.getByText("Reach them by"));
  return label.parentElement?.textContent ?? "";
};

describe("a teammate's vendor record", () => {
  it("reaches the vendor by Text on the workspace line", async () => {
    messaging.status = workspaceLine({ canSend: true });
    renderOverview();

    expect(await reachRow()).toBe("Reach them byText");

    writeEvidenceSurface(
      "08-vendor-record-teammate-text",
      "Teammate on Pacific Plumbing's record — \"Reach them by Text\", because the text leaves on the workspace's number (+1 206 555-0199) that the owner holds.",
    );
  });

  it("falls back to Email for a read-only teammate even though the line is live", async () => {
    messaging.status = workspaceLine({ canSend: false });
    renderOverview();

    expect(await reachRow()).toBe("Reach them byEmail");

    writeEvidenceSurface(
      "09-vendor-record-readonly-teammate-email",
      "The same live line, but this teammate has read-only Communication (canSend: false) — Text is not offered, so the send never comes back 403.",
    );
  });
});
