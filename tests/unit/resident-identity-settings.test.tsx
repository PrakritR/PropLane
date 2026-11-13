// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
import { ResidentIdentitySettings } from "@/components/portal/resident-identity-settings";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("resident identity settings", () => {
  it("renders nothing at all when verification is unavailable and nothing is pending", async () => {
    // The shipping state with the provider flags disabled: every resident's Settings would
    // otherwise carry an "Unavailable" verification block and a dead background-check section.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "unavailable", manualReview: null }) }));
    const { container } = render(<ResidentIdentitySettings />);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.textContent).toBe(""));
    expect(screen.queryByText("Verification")).toBeNull();
    expect(screen.queryByText("Background check")).toBeNull();
    expect(screen.queryByRole("link", { name: "Contact PropLane support" })).toBeNull();
  });
  it("still offers support for an outstanding manual review while the provider is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "unavailable", manualReview: "requested" }) }));
    render(<ResidentIdentitySettings />);
    expect(await screen.findByText("Requested")).toBeTruthy();
    const link = await screen.findByRole("link", { name: "Contact support" });
    expect(link.getAttribute("href")).toBe("/resident/profile?tab=feedback");
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
    expect(screen.queryByText("Background check")).toBeNull();
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
