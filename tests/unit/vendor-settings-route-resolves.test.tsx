// @vitest-environment jsdom
//
// VD01/VD66: vendor Settings was regrouped into Business / Account and Work
// contacts + Work number + Work email were merged into one "work" section;
// Workspace access was removed outright (VD66). Every OLD ?tab= deep link
// must keep resolving to a real pane rather than 404ing or landing on
// "Nothing here yet".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

let currentTab = "business";

vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/profile",
  useSearchParams: () => new URLSearchParams(currentTab ? `tab=${currentTab}` : ""),
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

describe("vendor Settings — old tab ids still resolve after the VD01/VD66 regroup", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the merged 'work' tab renders Work contact & email", async () => {
    currentTab = "work";
    mockFetchByUrl({
      "/api/vendor/profile": { profile: {}, linked: true, contact: {} },
      "/api/vendor/business-profile": { profile: {}, workspaces: [] },
      "/api/vendor/work-identity": { ok: true, identity: null },
    });
    render(<VendorSettingsPanel />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Work contact & email");
    });
  });

  for (const legacy of ["work-contacts", "work-number", "work-email"]) {
    it(`legacy ?tab=${legacy} resolves to the merged Work contact & email pane, not a 404`, async () => {
      currentTab = legacy;
      mockFetchByUrl({
        "/api/vendor/profile": { profile: {}, linked: true, contact: {} },
        "/api/vendor/business-profile": { profile: {}, workspaces: [] },
        "/api/vendor/work-identity": { ok: true, identity: null },
      });
      render(<VendorSettingsPanel />);
      await waitFor(() => {
        expect(document.body.textContent).toContain("Work contact & email");
      });
    });
  }

  for (const legacy of ["workspaces", "workspace-access"]) {
    it(`legacy ?tab=${legacy} (removed studio VD66) resolves to Business profile, not a 404`, async () => {
      currentTab = legacy;
      mockFetchByUrl({
        "/api/vendor/profile": { profile: {}, linked: true, contact: {} },
        "/api/vendor/business-profile": { profile: {}, workspaces: [] },
      });
      render(<VendorSettingsPanel />);
      await waitFor(() => {
        expect(document.body.textContent).toContain("Business profile");
      });
    });
  }

  it("the Settings rail no longer lists Availability (it moved to the Calendar)", async () => {
    currentTab = "business";
    mockFetchByUrl({
      "/api/vendor/profile": { profile: {}, linked: true, contact: {} },
      "/api/vendor/business-profile": { profile: {}, workspaces: [] },
    });
    render(<VendorSettingsPanel />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Business profile");
    });
    expect(document.body.textContent).not.toContain("Availability");
    expect(document.body.textContent).not.toContain("Hours & dates");
  });

  it("Workspace access no longer appears anywhere in the nav (VD66)", async () => {
    currentTab = "business";
    mockFetchByUrl({
      "/api/vendor/profile": { profile: {}, linked: true, contact: {} },
      "/api/vendor/business-profile": { profile: {}, workspaces: [] },
    });
    render(<VendorSettingsPanel />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Business profile");
    });
    expect(document.body.textContent).not.toContain("Workspace access");
  });
});
