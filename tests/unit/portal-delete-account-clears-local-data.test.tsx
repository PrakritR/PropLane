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
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

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
  /**
   * The confirm modal is a Radix dialog, and its focus scope restores focus on a DEFERRED task.
   * Unmounting without letting that task run leaves it queued; in a full suite run the next file
   * replaces the jsdom realm first, and the deferred `dispatchEvent` then lands on a node whose
   * document is gone — the unhandled error the suite reported. So: unmount, then drain a
   * macrotask while this file's realm is still the live one. Nothing is suppressed.
   */
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  it("drops the local portal caches once the server confirms the delete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, signedOut: true, redirectTo: "/auth/sign-in?deleted=1" }),
      })),
    );

    // The success path replaces the document location. jsdom cannot navigate, and the
    // "Not implemented" it logs is noise from a real call this test is not about. `location`
    // itself is non-configurable, so the stand-in replaces the whole object for this test and
    // `vi.unstubAllGlobals()` in `afterEach` puts the real one back.
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace, assign: vi.fn() });

    render(<PortalDeleteAccountButton portalKind="manager" />);
    fireEvent.click(screen.getByText("Delete account"));
    fireEvent.click(screen.getByText("Yes, delete account"));

    await waitFor(() => expect(clearPortalBrowserCache).toHaveBeenCalled());
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/sign-in?deleted=1"));
  });

  it("keeps the local caches when the server refuses", async () => {
    clearPortalBrowserCache.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "nope" }) })),
    );

    render(<PortalDeleteAccountButton portalKind="resident" />);
    fireEvent.click(screen.getByText("Delete account"));
    fireEvent.click(screen.getByText("Yes, delete account"));

    await waitFor(() => expect(screen.getByText("Yes, delete account")).toBeTruthy());
    expect(clearPortalBrowserCache).not.toHaveBeenCalled();
  });
});
