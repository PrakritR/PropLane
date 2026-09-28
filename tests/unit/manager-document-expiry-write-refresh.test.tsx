// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/portal/documents" }
//
// The dashboard's document-expiry banner is now TTL-guarded
// (`loadDocumentExpirationSummary`, 15s), which fixed a 6x refetch during first
// paint but introduced a freshness risk: a manager who deletes an expiring
// document and lands on the dashboard inside the TTL would still be told the
// old counts.
//
// `ManagerDocumentLibrary` closes that by forcing a read on the SAME user key
// the dashboard reads after every write. This drives the REAL component through
// the REAL delete path and then reads the summary exactly the way
// `manager-dashboard.tsx` does (unforced, inside the TTL) — the count it gets
// must be the post-write one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Match the providers' stable callbacks. A fresh showToast on each render
// changes the library's load callback and repeatedly restarts its load effect.
const ui = vi.hoisted(() => ({
  confirm: vi.fn((req: { description?: unknown }) => Promise.resolve(
    window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
  )),
  showToast: vi.fn(),
  navigate: vi.fn(),
  searchParams: new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => ui.confirm,
  useAppUi: () => ({ showToast: ui.showToast }),
}));
vi.mock("@/lib/manager-vendors-storage", () => ({
  MANAGER_VENDORS_EVENT: "manager-vendors",
  syncManagerVendorsFromServer: async () => [],
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => ui.searchParams,
  usePathname: () => "/portal/documents",
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => ui.navigate }));

import { ManagerDocumentLibrary } from "@/components/portal/pro-document-library";
import {
  loadDocumentExpirationSummary,
  resetDocumentExpirationSummaryCache,
} from "@/lib/manager-document-expiry-client";

const MANAGER = "mgr-doc-refresh";

const DOC = {
  id: "doc-1",
  displayName: "Boiler inspection certificate",
  fileName: "boiler.pdf",
  category: "compliance",
  scope: "portfolio",
  propertyId: null,
  propertyLabel: null,
  vendorId: null,
  vendorName: null,
  sizeBytes: 1024,
  mimeType: "application/pdf",
  expiresAt: "2026-08-20",
  notes: null,
  version: 1,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

/** Counts the server reports; the "write" flips it, like a real deletion would. */
let expiringSoon = 3;
let expired = 1;
const requestLog: string[] = [];

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? input);
    const method = init?.method ?? "GET";
    requestLog.push(`${method} ${url.split("?")[0]}`);
    if (url.includes("/api/manager-documents/expiration-summary")) {
      return {
        ok: true,
        json: async () => ({ summary: { expiringSoon, expired, total: expiringSoon + expired } }),
      } as unknown as Response;
    }
    if (method === "DELETE" && /\/api\/manager-documents\/doc-1$/.test(url)) {
      // The document is gone, so the server's counts drop.
      expiringSoon = 2;
      expired = 0;
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }
    if (url.includes("/api/manager-documents")) {
      return { ok: true, json: async () => ({ documents: [DOC] }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  expiringSoon = 3;
  expired = 1;
  requestLog.length = 0;
  resetDocumentExpirationSummaryCache();
  vi.stubGlobal("fetch", stubFetch());
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Exactly what `manager-dashboard.tsx` does: an unforced, TTL-guarded read. */
const dashboardRead = () => loadDocumentExpirationSummary({ userId: MANAGER });

describe("document write → dashboard expiry counts", () => {
  it("reports live expiry counts after the library loads", async () => {
    const onExpiryPillsChange = vi.fn();
    render(
      <ManagerDocumentLibrary
        userId={MANAGER}
        onExpiryPillsChange={onExpiryPillsChange}
      />,
    );

    await screen.findAllByText(/Boiler inspection certificate/);
    await waitFor(() => {
      expect(onExpiryPillsChange).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: "", label: "All", count: 1 })]),
      );
    });
  });

  it("forces a refresh so the dashboard's next read is newer than the delete", async () => {
    // The dashboard has already painted once, so the TTL cache is warm.
    expect(await dashboardRead()).toMatchObject({ expiringSoon: 3, expired: 1 });

    // Delete now lives behind the document's own record page header icon
    // (PLAN-0920-1058, area 1c) rather than an inline row expand.
    const { container } = render(<ManagerDocumentLibrary userId={MANAGER} documentId="doc-1" />);
    await screen.findAllByText(/Boiler inspection certificate/);

    const deleteBtn = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>('[data-attr="record-header-action-delete"]');
      expect(el).toBeInTheDocument();
      expect(el).toBeEnabled();
      return el!;
    });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining(DOC.displayName) }));
      expect(requestLog).toContain("DELETE /api/manager-documents/doc-1");
    });
    await waitFor(async () => {
      // Still well inside the 15s TTL — only the forced post-write read can
      // make this the new number.
      expect(await dashboardRead()).toMatchObject({ expiringSoon: 2, expired: 0 });
      const deleteIndex = requestLog.indexOf("DELETE /api/manager-documents/doc-1");
      expect(requestLog.slice(deleteIndex + 1)).toContain("GET /api/manager-documents/expiration-summary");
    });
  });

  it("without that forced read the same window would still serve the pre-write counts", async () => {
    // Control: the cache is warm and the write happens outside the component,
    // so nothing forces it — this is the staleness the fix removes.
    expect(await dashboardRead()).toMatchObject({ expiringSoon: 3, expired: 1 });
    expiringSoon = 2;
    expired = 0;
    expect(await dashboardRead()).toMatchObject({ expiringSoon: 3, expired: 1 });
  });
});
