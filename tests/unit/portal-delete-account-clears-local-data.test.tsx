// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { clearPortalBrowserCache } = vi.hoisted(() => ({ clearPortalBrowserCache: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/portal/settings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("posthog-js", () => ({ default: { reset: () => {} } }));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: { signOut: async () => ({ error: null }) } }),
}));
vi.mock("@/lib/auth/clear-portal-browser-cache", () => ({ clearPortalBrowserCache }));

import { PortalDeleteAccountButton } from "@/components/portal/portal-delete-account-button";

/**
 * The server purge cannot reach localStorage, and several portal panels mirror their local
 * copies back to the server on the next sign-in. Leaving those behind is how a deleted
 * account's properties and applications reappear — under the same email on a fresh signup.
 */
describe("PortalDeleteAccountButton", () => {
  afterEach(() => cleanup());

  it("drops the local portal caches once the server confirms the delete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, signedOut: true, redirectTo: "/auth/sign-in?deleted=1" }),
      })),
    );

    render(<PortalDeleteAccountButton portalKind="manager" />);
    fireEvent.click(screen.getByText("Delete account"));
    fireEvent.click(screen.getByText("Yes, permanently delete"));

    await waitFor(() => expect(clearPortalBrowserCache).toHaveBeenCalled());
  });

  it("keeps the local caches when the server refuses", async () => {
    clearPortalBrowserCache.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "nope" }) })),
    );

    render(<PortalDeleteAccountButton portalKind="resident" />);
    fireEvent.click(screen.getByText("Delete account"));
    fireEvent.click(screen.getByText("Yes, permanently delete"));

    await waitFor(() => expect(screen.getByText("Yes, permanently delete")).toBeTruthy());
    expect(clearPortalBrowserCache).not.toHaveBeenCalled();
  });
});
