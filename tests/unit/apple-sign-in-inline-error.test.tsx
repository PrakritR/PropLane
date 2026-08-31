// @vitest-environment jsdom
//
// The Apple button's inline failure slot replaces the toast when `onError` is provided.
// Toast only fires for callers with nowhere else to put the message.
//
// Each attempt clears the inline slot first, so a repeated failure still re-shows the reason —
// the same silent "it just did nothing" the native OAuth work exists to remove.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();
const startAppleSignIn = vi.fn();

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: {} }),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

vi.mock("@/lib/auth/start-apple-sign-in", () => ({
  startAppleSignIn: (...args: unknown[]) => startAppleSignIn(...args),
}));

// Native Apple sign-in short-circuits the component's web OAuth probe effect.
vi.mock("@/lib/auth/native-apple-sign-in", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/native-apple-sign-in")>()),
  canUseNativeAppleSignIn: () => true,
}));

const FAILURE = "Apple sign-in is not enabled in this Supabase project.";

describe("AppleSignInButton inline error", () => {
  beforeEach(async () => {
    showToast.mockReset();
    startAppleSignIn.mockReset();
    startAppleSignIn.mockResolvedValue({ ok: false, message: FAILURE });
    const { resetAppleSignInSessionStateForTests } = await import("@/lib/auth/apple-sign-in-config");
    resetAppleSignInSessionStateForTests();
  });

  afterEach(() => {
    cleanup();
    vi.resetModules();
  });

  it("keeps the reason on screen when the same failure happens twice", async () => {
    const { AppleSignInButton } = await import("@/components/auth/apple-sign-in-button");

    let inlineError = "";
    render(
      <AppleSignInButton
        onError={(message) => {
          inlineError = message;
        }}
      />,
    );

    fireEvent.click(screen.getByText("Continue with Apple"));
    await waitFor(() => expect(inlineError).toBe(FAILURE));
    expect(showToast).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Continue with Apple"));
    await waitFor(() => expect(startAppleSignIn).toHaveBeenCalledTimes(2));

    // With an inline slot, toast must stay quiet — the form already shows the reason.
    await waitFor(() => expect(inlineError).toBe(FAILURE));
    expect(showToast).not.toHaveBeenCalled();
  });

  it("toasts when there is no inline error slot", async () => {
    const { AppleSignInButton } = await import("@/components/auth/apple-sign-in-button");

    render(<AppleSignInButton />);
    fireEvent.click(screen.getByText("Continue with Apple"));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(FAILURE));
  });

  it("shows no inline error when the user dismisses the Apple sheet", async () => {
    // Cancelling is not a failure. `openOAuthUrl` already treats the WebAuthSession CANCELED
    // code as a silent no-op, so leaving red text under the form here would have one branch
    // answering the same question two opposite ways.
    const { AppleSignInButton } = await import("@/components/auth/apple-sign-in-button");
    const { APPLE_SIGN_IN_CANCELLED_MESSAGE } = await import("@/lib/auth/native-apple-sign-in");

    startAppleSignIn.mockResolvedValue({
      ok: false,
      message: APPLE_SIGN_IN_CANCELLED_MESSAGE,
      cancelled: true,
    });

    const inlineErrors: string[] = [];
    render(<AppleSignInButton onError={(message) => inlineErrors.push(message)} />);

    fireEvent.click(screen.getByText("Continue with Apple"));
    await waitFor(() => expect(startAppleSignIn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Continue with Apple")).toBeTruthy());

    // The only call is the pre-attempt clear, never the cancellation copy.
    expect(inlineErrors.filter(Boolean)).toEqual([]);
  });

  it("still clears a stale inline error when the next attempt is cancelled", async () => {
    const { AppleSignInButton } = await import("@/components/auth/apple-sign-in-button");
    const { APPLE_SIGN_IN_CANCELLED_MESSAGE } = await import("@/lib/auth/native-apple-sign-in");

    let inlineError = "";
    render(
      <AppleSignInButton
        onError={(message) => {
          inlineError = message;
        }}
      />,
    );

    fireEvent.click(screen.getByText("Continue with Apple"));
    await waitFor(() => expect(inlineError).toBe(FAILURE));

    startAppleSignIn.mockResolvedValue({
      ok: false,
      message: APPLE_SIGN_IN_CANCELLED_MESSAGE,
      cancelled: true,
    });
    fireEvent.click(screen.getByText("Continue with Apple"));
    await waitFor(() => expect(inlineError).toBe(""));
  });
});
