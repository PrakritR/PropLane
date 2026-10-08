// @vitest-environment jsdom
//
// Vendor Settings in the manager-settings layout (vendor-portal-redesign-1006):
// a rail of Profile · Business · Money · Communication, each page a real pane.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { resetSharedGets } from "@/lib/shared-get-cache";

let currentTab = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/profile",
  useSearchParams: () => new URLSearchParams(currentTab ? `tab=${currentTab}` : ""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: { getUser: () => Promise.resolve({ data: { user: null } }) } }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { VendorSettingsPanel } from "@/components/portal/vendor-settings-panel";

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/vendor/quick-replies")
        ? { replies: [{ id: "s1", text: "On my way" }], isStarterSet: true }
        : url.includes("/api/vendor/profile")
          ? { profile: {}, linked: true, contact: {} }
          : url.includes("/api/vendor/business-profile")
            ? { profile: {}, workspaces: [] }
            : {};
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
}

afterEach(() => {
  cleanup();
  resetSharedGets();
  vi.unstubAllGlobals();
});

const renderAt = (tab: string) => {
  currentTab = tab;
  stub();
  return render(
    <AppUiProvider>
      <VendorSettingsPanel />
    </AppUiProvider>,
  );
};
const text = () => document.body.textContent ?? "";

describe("vendor settings rail", () => {
  it("lists the four groups and every page from the approved plan", async () => {
    renderAt("business");
    await waitFor(() => expect(document.querySelector('[data-attr="settings-layout"]')).toBeTruthy());
    const rail = document.querySelector('nav[aria-label="Settings sections"]')!.textContent!;
    for (const label of [
      "Profile", "Login & security",
      "Business", "Business details", "Trades & service area", "AI info",
      "Money", "Payouts", "Invoicing",
      "Communication", "Phone & notifications", "Quick replies",
    ]) {
      expect(rail).toContain(label);
    }
  });

  it("marks the active page and titles it", async () => {
    renderAt("quick-replies");
    await waitFor(() => expect(document.querySelector('[data-attr="settings-page-title"]')?.textContent).toBe("Quick replies"));
    expect(document.querySelector('[data-attr="settings-nav-quick-replies"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("Quick replies page renders the vendor's list", async () => {
    renderAt("quick-replies");
    await waitFor(() => expect(text()).toContain("On my way"));
    expect(document.querySelector('[data-attr="vendor-quick-replies-add"]')).toBeTruthy();
  });

  it("Phone & notifications keeps the verify-phone control", async () => {
    renderAt("messaging");
    await waitFor(() => expect(text()).toContain("Verify your phone"));
  });

  it("an old ?tab=notifications link lands on Phone & notifications", async () => {
    renderAt("notifications");
    await waitFor(() => expect(document.querySelector('[data-attr="settings-page-title"]')?.textContent).toBe("Phone & notifications"));
  });

  it("Trades & service area is one card with a Service area row and a Trades dropdown; Business details no longer asks for the area", async () => {
    renderAt("capabilities");
    await waitFor(() => expect(document.querySelector('[data-attr="vendor-business-service-area"]')).toBeTruthy());
    const rows = [...document.querySelectorAll("p")].map((p) => p.textContent);
    expect(rows.filter((t) => t === "Service area")).toHaveLength(1);
    expect(rows.filter((t) => t === "Trades")).toHaveLength(1);
    // no checkbox grid, no section subhead repeating the label
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-slot="settings-section"]')).toHaveLength(0);
    cleanup();
    renderAt("business");
    await waitFor(() => expect(text()).toContain("Business name"));
    expect(text()).not.toContain("Service area");
    expect(text()).toContain("Work contact & email");
  });

  it("Invoicing and Payouts are pages in the Money group", async () => {
    renderAt("invoicing");
    await waitFor(() => expect(document.querySelector('[data-attr="vendor-invoicing-settings"]')).toBeTruthy());
  });
});
