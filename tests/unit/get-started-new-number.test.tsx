// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ params: new URLSearchParams(), getSession: vi.fn(), resolve: vi.fn(), provision: vi.fn(), navigate: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => mocks.params }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { getSession: mocks.getSession, signOut: vi.fn() } }) }));
vi.mock("@/lib/auth/resolve-post-auth-destination", async (original) => ({
  ...(await original<typeof import("@/lib/auth/resolve-post-auth-destination")>()), resolvePostAuthDestination: mocks.resolve,
}));
vi.mock("@/lib/auth/provision-portal-from-get-started", () => ({ provisionPortalFromGetStarted: mocks.provision }));
vi.mock("@/lib/auth/navigate-after-role-signup", () => ({ navigateAfterRoleSignup: mocks.navigate }));
vi.mock("posthog-js", () => ({ default: { reset: vi.fn() } }));

import GetStartedPage from "@/app/auth/get-started/page";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

const page = () => render(<AppUiProvider><GetStartedPage /></AppUiProvider>);

beforeEach(() => {
  mocks.params = new URLSearchParams();
  mocks.getSession.mockResolvedValue({ data: { session: { user: { phone: "15103098345" } } } });
  mocks.resolve.mockResolvedValue({ redirectTo: "/auth/get-started", resolutionFailed: false });
  mocks.provision.mockResolvedValue({ ok: true, redirectTo: "/resident/dashboard" });
});
afterEach(() => cleanup());

describe("get-started for a number with no account", () => {
  it("names the number and offers the three ways in, wired to the existing role routes", async () => {
    mocks.params = new URLSearchParams("phone_new=1");
    page();
    expect(await screen.findByRole("heading", { name: "No account uses (510) 309-8345 yet" })).toBeInTheDocument();
    const labels = screen.getAllByRole("button").map((button) => button.textContent ?? "");
    expect(labels.findIndex((l) => l.includes("I'm looking for a place"))).toBeLessThan(labels.findIndex((l) => l.includes("I manage homes")));
    expect(labels.findIndex((l) => l.includes("I manage homes"))).toBeLessThan(labels.findIndex((l) => l.includes("I'm a vendor")));
  });

  it.each([["I'm looking for a place", "resident"], ["I manage homes", "manager"], ["I'm a vendor", "vendor"]])("%s provisions the %s role through the existing route", async (label, role) => {
    mocks.params = new URLSearchParams("phone_new=1");
    page();
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(label) }));
    await waitFor(() => expect(mocks.provision).toHaveBeenCalledWith(role));
  });

  it("without the flag it is the ordinary role picker", async () => {
    page();
    expect(await screen.findByRole("heading", { name: "How do you want to use PropLane?" })).toBeInTheDocument();
    expect(screen.queryByText(/No account uses/)).not.toBeInTheDocument();
  });

  it("with the flag but no readable number it falls back to the ordinary heading rather than inventing one", async () => {
    mocks.params = new URLSearchParams("phone_new=1");
    mocks.getSession.mockResolvedValue({ data: { session: { user: {} } } });
    page();
    expect(await screen.findByRole("heading", { name: "How do you want to use PropLane?" })).toBeInTheDocument();
  });
});
