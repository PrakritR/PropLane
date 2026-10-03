// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), push: vi.fn(), refresh: vi.fn(), toast: vi.fn(), localSignOut: vi.fn(), clear: vi.fn(), reset: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => mocks.confirm, useAppUi: () => ({ showToast: mocks.toast }) }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { signOut: mocks.localSignOut } }) }));
vi.mock("@/lib/demo-property-pipeline", () => ({ clearPrivateTestWorkspaceListings: mocks.clear }));
vi.mock("posthog-js", () => ({ default: { reset: mocks.reset } }));
import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("sign-out confirmation", () => {
  it("does not end a session when the confirmation is cancelled", async () => {
    mocks.confirm.mockResolvedValue(false);
    const closeMenu = vi.fn();
    render(<PortalSignOutButton onRequestConfirm={closeMenu} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Sign out", tone: "danger", confirmLabel: "Sign out" })));
    expect(closeMenu).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it("clears the local session only after an approved server sign-out", async () => {
    mocks.confirm.mockResolvedValue(true);
    render(<PortalSignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/auth/sign-in"));
    expect(fetch).toHaveBeenCalledWith("/api/auth/sign-out", { method: "POST", credentials: "include" });
    expect(mocks.localSignOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });
  it("keeps the session when the server refuses and offers retry", async () => {
    mocks.confirm.mockResolvedValue(true);
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    render(<PortalSignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign out" })).not.toBeDisabled();
  });
});
