// @vitest-environment jsdom
//
// Settings > Availability used to mount its own settings-local fork of
// `VendorAvailabilityEditor`, defined inside vendor-settings-panel.tsx —
// a second editor with its own weekly/open/blocked-dates markup that could
// drift from the canonical one the vendor Calendar page's "Set availability"
// dialog uses. That fork has been deleted; the tab now renders the one
// canonical `VendorAvailabilityEditor` (vendor-availability-editor.tsx)
// inline (`dialog={false}`), so both surfaces share the same fields, saves,
// and VENDOR_AVAILABILITY_CHANGED_EVENT / VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT
// contract.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/profile",
  useSearchParams: () => new URLSearchParams("tab=availability"),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: { getUser: () => Promise.resolve({ data: { user: null } }) } }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { VendorSettingsPanel } from "@/components/portal/vendor-settings-panel";

function mockFetchByUrl(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const match = Object.keys(routes).find((k) => url.includes(k));
      return { ok: true, json: async () => (match ? routes[match] : {}) };
    }),
  );
}

describe("vendor Settings > Availability renders the one canonical VendorAvailabilityEditor", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("mounts the canonical editor's weekly-hours + date-overrides markup, not the deleted settings-local fork", async () => {
    mockFetchByUrl({
      "/api/vendor/profile": { profile: {}, linked: true, contact: {} },
      "/api/vendor/business-profile": { profile: {}, workspaces: [] },
      "/api/vendor/availability": { rules: [] },
    });

    const { container } = render(<VendorSettingsPanel />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Weekly hours");
      expect(document.body.textContent).toContain("Date overrides");
    });

    // `vw-avail` is the canonical editor's own root data-attr, and the merged
    // "Date overrides" add button is unique to it — the deleted fork used
    // "vendor-availability-add-weekly" and a separate "Blocked dates" section
    // instead of one merged override list.
    expect(container.querySelector('[data-attr="vw-avail"]')).toBeTruthy();
    expect(container.querySelector('[data-attr="vendor-availability-add-override"]')).toBeTruthy();
    expect(container.querySelector('[data-attr="vendor-availability-add-weekly"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Blocked dates");
  });
});
