// @vitest-environment jsdom
//
// "Login & security" has two shapes, decided by whether the account actually HAS a
// password. A Google/Apple-only account has none, so asking it for a "current password"
// is an unanswerable question — it must be asked to SET one instead.
//
// The signal is deliberately server-side (`current_user_has_password`), because nothing
// client-visible carries it: the GoTrue user payload has no password field, and
// `identities` / `app_metadata.providers` only say which providers are linked — a
// passwordless account can still carry an `email` identity.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const rpc = vi.fn();
const updateUser = vi.fn();
const signInWithPassword = vi.fn();
const toasts: string[] = [];

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ rpc, auth: { updateUser, signInWithPassword } }),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast: (m: string) => void toasts.push(m) }),
}));

vi.mock("@/lib/auth/request-password-reset", () => ({
  requestPasswordReset: vi.fn(async () => ({ ok: true })),
}));

const demoActive = vi.fn(() => false);
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => demoActive(),
}));

import { PortalChangePasswordPanel } from "@/components/portal/portal-change-password-panel";
import { fetchCurrentUserHasPassword, HAS_PASSWORD_RPC } from "@/lib/auth/current-user-has-password";

const EMAIL = "social@example.com";

function type(id: string, value: string) {
  const el = document.getElementById(id) as HTMLInputElement;
  fireEvent.change(el, { target: { value } });
}

function currentPasswordField() {
  return document.getElementById("portal-old-password");
}

async function openPassword() {
  const trigger = await screen.findByRole("button", { name: /^(Set|Change) password$/ });
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
  fireEvent.click(trigger);
}
function submitPassword() {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^(Set|Update) password$/ }));
}

beforeEach(() => {
  rpc.mockReset();
  updateUser.mockReset();
  signInWithPassword.mockReset();
  demoActive.mockReturnValue(false);
  toasts.length = 0;
  updateUser.mockResolvedValue({ error: null });
  signInWithPassword.mockResolvedValue({ error: null });
});

afterEach(cleanup);

describe("Login & security for an account with NO password (Google/Apple only)", () => {
  beforeEach(() => rpc.mockResolvedValue({ data: false, error: null }));

  it("asks to set a password and never shows a Current password field", async () => {
    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);

    expect(await screen.findByRole("button", { name: "Set password" })).toBeTruthy();
    expect(currentPasswordField()).toBeNull();
    expect(screen.queryByText(/current password/i)).toBeNull();
    // No sentence under the section title (AGENTS.md § No subtext).
    expect(screen.queryByText(/set a password to also sign in with your email/i)).toBeNull();
  });

  it("drops the meaningless 'forgot your current password' reset escape hatch", async () => {
    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);
    await openPassword();

    expect(screen.queryByText(/forgot your current password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /send a reset link/i })).toBeNull();
  });

  it("sets the password without asking Supabase to verify one that does not exist", async () => {
    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);
    await openPassword();

    type("portal-new-password", "brand-new-password");
    type("portal-confirm-password", "brand-new-password");
    submitPassword();

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: "brand-new-password" }));
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("still enforces the same strength and confirmation rules", async () => {
    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);
    await openPassword();

    type("portal-new-password", "short");
    type("portal-confirm-password", "short");
    submitPassword();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/at least 8 characters/i));
    expect(updateUser).not.toHaveBeenCalled();

    type("portal-new-password", "long-enough-password");
    type("portal-confirm-password", "different-password-x");
    submitPassword();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/do not match/i));
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("switches to the update flow once a password exists, without a reload", async () => {
    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);
    await openPassword();
    expect(currentPasswordField()).toBeNull();

    type("portal-new-password", "brand-new-password");
    type("portal-confirm-password", "brand-new-password");
    submitPassword();

    await waitFor(() => expect(toasts.at(-1)).toMatch(/password set/i));
    // The transition itself: label, the reappearing Current password field, and the
    // reset escape hatch all come back.
    await openPassword();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Update password" })).toBeTruthy();
    expect(currentPasswordField()).not.toBeNull();
    expect(screen.getByText(/send a reset link to your email/i)).toBeTruthy();
    expect(toasts.at(-1)).toMatch(/password set/i);
  });
});

describe("Login & security for an account that already HAS a password", () => {
  beforeEach(() => rpc.mockResolvedValue({ data: true, error: null }));

  it("is unchanged: update label, Current password field, reset link", async () => {
    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);

    await openPassword();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Update password" })).toBeTruthy();
    expect(currentPasswordField()).not.toBeNull();
    expect(screen.getByText(/send a reset link to your email/i)).toBeTruthy();
  });

  it("still refuses to update without the current password", async () => {
    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);
    await openPassword();

    type("portal-new-password", "brand-new-password");
    type("portal-confirm-password", "brand-new-password");
    submitPassword();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/enter your current password/i));
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("verifies the current password before changing it", async () => {
    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);
    await openPassword();

    type("portal-old-password", "the-old-password");
    type("portal-new-password", "brand-new-password");
    type("portal-confirm-password", "brand-new-password");
    submitPassword();

    await waitFor(() =>
      expect(signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: "the-old-password" }),
    );
    expect(updateUser).toHaveBeenCalledWith({ password: "brand-new-password" });
  });
});

describe("on /demo", () => {
  it("shows the ordinary update form without an authed round trip", async () => {
    demoActive.mockReturnValue(true);
    rpc.mockResolvedValue({ data: false, error: null });

    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);

    await openPassword();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Update password" })).toBeTruthy();
    expect(currentPasswordField()).not.toBeNull();
    // The demo sandbox never makes the authed call at all.
    expect(rpc).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});

describe("fetchCurrentUserHasPassword", () => {
  it("passes through a real answer and fails closed on anything else", async () => {
    const call = (result: unknown) =>
      fetchCurrentUserHasPassword({ rpc: async () => result } as never);

    expect(await call({ data: false, error: null })).toBe(false);
    expect(await call({ data: true, error: null })).toBe(true);
    // Error, wrong shape, or a throw must all read as "has a password", the state that
    // still demands the current-password confirmation.
    expect(await call({ data: null, error: { message: "denied" } })).toBe(true);
    expect(await call({ data: "yes", error: null })).toBe(true);
    expect(
      await fetchCurrentUserHasPassword({
        rpc: async () => {
          throw new Error("offline");
        },
      } as never),
    ).toBe(true);
  });

  it("names the function the migration actually creates", () => {
    expect(HAS_PASSWORD_RPC).toBe("current_user_has_password");
  });
});

describe("when the server cannot answer", () => {
  it("fails closed to the current-password flow rather than offering a free set", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);

    await openPassword();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Update password" })).toBeTruthy();
    expect(currentPasswordField()).not.toBeNull();
  });

  it("does not flash either form while the answer is still in flight", () => {
    rpc.mockReturnValue(new Promise(() => {}));
    render(<PortalChangePasswordPanel accountEmail={EMAIL} />);

    expect(screen.getByRole("button", { name: /password/i }).hasAttribute("disabled")).toBe(true);
    expect(currentPasswordField()).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });
});
