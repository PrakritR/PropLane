// @vitest-environment jsdom
//
// Settings > Business > AI info, and the end of vendor onboarding ("You're set up" with the number).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/portal/vendor-work-number-settings", () => ({ VendorWorkNumberSettings: () => null }));
vi.mock("@/components/portal/portal-text-notifications-block", () => ({ PortalTextNotificationsBlock: () => null }));

import { VendorAiInfoPane } from "@/components/portal/vendor-ai-info-settings";
import { VendorOnboardingFlow } from "@/components/portal/vendor-onboarding";
import { VENDOR_SETTINGS_RAIL, resolveVendorSettingsTab, vendorSettingsHref } from "@/lib/portals/vendor-settings-pages";
import { EMPTY_VENDOR_AI_INFO } from "@/lib/vendor-ai-info";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings > Business > AI info", () => {
  it("is a page in the Business group with its own deep link", () => {
    const business = VENDOR_SETTINGS_RAIL.find((g) => g.label === "Business")!;
    expect(business.pages.map((p) => p.label)).toContain("AI info");
    expect(resolveVendorSettingsTab("ai-info")).toBe("ai-info");
    expect(vendorSettingsHref("ai-info")).toBe("/vendor/profile?tab=ai-info");
    expect(readFileSync(join(process.cwd(), "src/components/portal/vendor-settings-panel.tsx"), "utf8")).toContain('case "ai-info"');
  });

  const ctxWith = (save = vi.fn(async () => ({ ok: true }))) =>
    ({
      profile: { serviceArea: "Seattle", trades: ["Plumbing", "Water heaters"], aiInfo: { ...EMPTY_VENDOR_AI_INFO, hours: "Mon-Fri 8-6" } },
      workspaces: [], loading: false, saving: false, error: null, save, reload: vi.fn(),
    }) as never;

  it("shows the business-detail rows read-only, one labeled box per answer, and no helper sentence", () => {
    render(<VendorAiInfoPane ctx={ctxWith()} />);
    expect(screen.getByText("Service area")).toBeTruthy();
    expect(screen.getByText("Seattle")).toBeTruthy();
    expect(screen.getByText("Plumbing, Water heaters")).toBeTruthy();
    for (const label of ["Hours", "Rates", "How to book", "Emergencies", "Anything else"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect((screen.getByLabelText("Hours") as HTMLTextAreaElement).value).toBe("Mon-Fri 8-6");
    // Each answer is a label and its box and nothing else: no muted sentence under either.
    for (const box of document.querySelectorAll("textarea")) {
      expect([...box.parentElement!.children].map((el) => el.tagName)).toEqual(["LABEL", "TEXTAREA"]);
    }
  });

  it("saves all five answers with the one Save button", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    render(<VendorAiInfoPane ctx={ctxWith(save)} />);
    fireEvent.change(screen.getByLabelText("Rates"), { target: { value: "$95 call" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ aiInfo: { ...EMPTY_VENDOR_AI_INFO, hours: "Mon-Fri 8-6", rates: "$95 call" } });
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("shows the server's reason when the save fails", async () => {
    const save = vi.fn(async () => ({ ok: false, error: "Hours must be 1000 characters or fewer." }));
    render(<VendorAiInfoPane ctx={ctxWith(save)} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("1000 characters"));
  });
});

describe("vendor onboarding Finish", () => {
  const profile = {
    businessName: "Apex", serviceArea: "Seattle", trades: ["Plumbing"], serviceAreaZips: [], serviceRadiusMiles: null,
    licenseNumber: "", licenseDocPath: null, insuranceProvider: "", insurancePolicyNumber: "", insuranceExpiresAt: null,
    insuranceDocPath: null, directoryListed: true, onboardingCompletedAt: null,
  };
  function stubFetch(workNumber: unknown) {
    const patch = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patch(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({ profile, ...(workNumber ? { workNumber } : {}) }) };
      }
      return { ok: true, json: async () => ({ profile }) };
    }));
    return patch;
  }
  beforeEach(() => nav.push.mockClear());

  it("asks the server to finish, then shows the number with a copy icon and the AI info link", async () => {
    const patch = stubFetch({ status: "provisioned", phoneNumber: "+12065550177" });
    render(<VendorOnboardingFlow />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(screen.getByText("You're set up")).toBeTruthy());
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ finishOnboarding: true }));
    // The body carries no number: it is chosen on the server.
    expect(JSON.stringify(patch.mock.calls[0])).not.toContain("5550177");
    expect(screen.getByText("+1 (206) 555-0177")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy work number" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up" }).getAttribute("href")).toBe("/vendor/profile?tab=ai-info");
    expect(nav.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Go to dashboard" }));
    expect(nav.push).toHaveBeenCalledWith("/vendor/dashboard");
  });

  it("goes straight to the dashboard when no number was allocated (gates off, unverified phone, soft-fail)", async () => {
    stubFetch({ status: "skipped", reason: "phone_unverified" });
    render(<VendorOnboardingFlow />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/vendor/dashboard"));
    expect(screen.queryByText("You're set up")).toBeNull();
  });
});
