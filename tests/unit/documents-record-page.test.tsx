// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost/portal/documents" }
// C062/C063 (captain, BUILD-WAVE2 §4, resolved "keep the single-modal
// viewer"): a Documents Library row opens the single preview modal in place,
// it no longer navigates to a 4-tab record page. The record-page route/
// component below still renders when reached directly (e.g. an old deep
// link) — it just isn't the row's own click target any more.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => async () => true,
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/lib/manager-vendors-storage", () => ({
  MANAGER_VENDORS_EVENT: "manager-vendors",
  syncManagerVendorsFromServer: async () => [],
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/portal/documents",
}));

import { ManagerDocumentLibrary } from "@/components/portal/pro-document-library";

const DOC = {
  id: "doc-1",
  displayName: "Boiler inspection certificate",
  originalFilename: "boiler.pdf",
  category: "compliance",
  scope: "portfolio",
  scopeKind: "manager",
  visibility: "manager",
  sizeBytes: 1024,
  mimeType: "application/pdf",
  expiresAt: null,
  signatureStatus: null,
  signatureRequestedAt: null,
  signedAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? input);
    if (url.includes("/signed-url")) {
      return { ok: true, json: async () => ({ url: "https://example.com/signed" }) } as unknown as Response;
    }
    if (url.includes("/api/manager-documents")) {
      return { ok: true, json: async () => ({ documents: [DOC] }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
}

afterEach(() => {
  cleanup();
  navigate.mockClear();
  vi.unstubAllGlobals();
});

describe("document library row opens the single preview modal", () => {
  it("clicking a row opens the preview modal in place, without navigating", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<ManagerDocumentLibrary userId="mgr-1" basePath="/portal" />);
    const row = await screen.findByText("Boiler inspection certificate");
    fireEvent.click(row);
    expect(navigate).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Boiler inspection certificate")).toBeTruthy();
    expect(within(dialog).getByText("Download")).toBeTruthy();
    expect(within(dialog).getByText("Edit")).toBeTruthy();
  });
});

describe("document record page", () => {
  it("the rail has Preview, Details, Communication, Activity and the header icons match the registry", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<ManagerDocumentLibrary userId="mgr-1" basePath="/portal" documentId="doc-1" />);
    await screen.findAllByText("Boiler inspection certificate");

    const rail = screen.getByRole("navigation", { name: "Document sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Preview", "Details", "Communication", "Activity"]);

    // Queried by data-attr since "Download" is also the phone sticky
    // primary's own button (jsdom renders both, unlike a real browser where
    // the desktop icon row is `hidden` below `lg`).
    expect(document.querySelector('[data-attr="record-header-action-download"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-share"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-delete"]')).not.toBeNull();
  });

  it("shows a not-found state for an unknown document id", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<ManagerDocumentLibrary userId="mgr-1" basePath="/portal" documentId="doc-missing" />);
    expect(await screen.findByText(/Document not found\./)).toBeTruthy();
  });
});
