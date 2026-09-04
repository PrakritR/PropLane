// @vitest-environment jsdom
/**
 * PRP-301 — "[vendor] Documents from managers: console error".
 *
 * `/vendor/documents/shared` fetches the shared-document list, and a vendor who
 * is not signed in or not yet linked gets a 401. That threw like any other
 * error, so the tab answered an ordinary state with a red "Failed to load
 * shared documents." toast — while the sibling tab in the SAME panel answered
 * the identical condition with a calm explanatory banner.
 *
 * Not signed in is not a failure. It gets an explanation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

import { PortalSharedDocumentsTable } from "@/components/portal/portal-shared-documents-table";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  showToast.mockReset();
});

function renderTable() {
  render(
    <PortalSharedDocumentsTable
      listUrl="/api/vendor/shared-documents"
      signedUrlBase="/api/vendor/shared-documents"
      emptyMessage="No documents shared with you yet."
      demoMessage="Documents from managers appear here."
    />,
  );
}

describe("shared documents when the caller is not authorized", () => {
  it.each([401, 403])("explains %i instead of raising an error toast", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status, json: async () => ({}) }) as unknown as Response),
    );
    renderTable();

    await waitFor(() =>
      expect(screen.getByText(/Sign in with a vendor account/i)).toBeTruthy(),
    );
    expect(showToast).not.toHaveBeenCalled();
  });

  it("still surfaces a REAL failure, so a broken route is not swallowed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as unknown as Response,
      ),
    );
    renderTable();

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("boom"));
  });

  it("shows the ordinary empty state when authorized with nothing shared", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({ ok: true, status: 200, json: async () => ({ documents: [] }) }) as unknown as Response,
      ),
    );
    renderTable();

    await waitFor(() =>
      expect(screen.getByText("No documents shared with you yet.")).toBeTruthy(),
    );
    expect(showToast).not.toHaveBeenCalled();
  });
});
