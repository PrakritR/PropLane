// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ResidentIdentitySettings } from "@/components/portal/resident-identity-settings";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("resident identity settings", () => {
  it("offers support when verification is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "unavailable", manualReview: null }) }));
    render(<ResidentIdentitySettings />);
    const link = await screen.findByRole("link", { name: "Contact support" });
    expect(link.getAttribute("href")).toBe("/resident/communication/active");
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
  });
  it("shows pending and exposes a resume action", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "pending", manualReview: null }) }));
    render(<ResidentIdentitySettings />);
    expect(await screen.findByText("Pending")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });
  it("shows provider and date for an approved attestation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "approved", provider: "Persona", verifiedAt: "2026-10-29T00:00:00Z", manualReview: null }) }));
    render(<ResidentIdentitySettings />);
    expect(await screen.findByText("Verified")).toBeTruthy();
    expect(screen.getByText("Persona")).toBeTruthy();
    expect(screen.getByText("Oct 29, 2026")).toBeTruthy();
  });
});
