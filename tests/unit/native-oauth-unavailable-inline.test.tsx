// @vitest-environment jsdom
//
// What the user sees when the native shell cannot run Google sign-in.
//
// The reported bug was "Continue with Google does nothing — the page just refreshes and goes
// back". That was two defects stacked:
//
//  1. `openOAuthUrl` reported a PRE-FLIGHT capability failure (an iOS binary with no
//     WebAuthSession plugin) by navigating the whole WebView to
//     `/auth/sign-in?error=oauth&message=…`. Nothing had been opened, so that navigation was a
//     pointless reload — and a reload is precisely what "it just refreshes" describes.
//  2. Nothing on the receiving end read those params, so the explanation was discarded and the
//     user was returned to a pristine sign-in screen with no reason given.
//
// Both are locked in here: the failure must arrive as a returned value the caller renders in
// place, and it must never be delivered by navigating.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const signInWithOAuth = vi.fn();
const showToast = vi.fn();

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: { signInWithOAuth } }),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

vi.mock("@/lib/auth/oauth-next-cookie", () => ({
  persistOAuthSignInContext: vi.fn(),
}));

vi.mock("@capacitor/browser", () => ({
  Browser: { open: vi.fn(), close: vi.fn(), addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })), getLaunchUrl: vi.fn(async () => undefined) },
}));

/**
 * Record every navigation instead of letting jsdom swallow it.
 *
 * jsdom leaves `location.href` unchanged on a cross-document assignment (it only logs "Not
 * implemented: navigation"), so asserting the href is unchanged passes even against code that
 * navigates. Replacing `window.location` with a recorder is what makes "never navigates" a real
 * assertion.
 */
function recordNavigations(): string[] {
  const navigations: string[] = [];
  const real = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      get origin() {
        return real.origin;
      },
      get pathname() {
        return real.pathname;
      },
      get search() {
        return real.search;
      },
      get hash() {
        return real.hash;
      },
      get href() {
        return real.href;
      },
      set href(value: string) {
        navigations.push(value);
      },
      assign: (value: string) => void navigations.push(value),
      replace: (value: string) => void navigations.push(value),
    },
  });
  return navigations;
}

function restoreLocation(real: Location): void {
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: real });
}

/** An iOS Capacitor shell whose binary predates the WebAuthSession plugin. */
function stubLegacyIosShell(): void {
  (window as unknown as { Capacitor: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    isPluginAvailable: () => false,
  };
  document.documentElement.setAttribute("data-native", "ios");
}

describe("native shell cannot run Google sign-in", () => {
  let realLocation: Location;
  let navigations: string[];

  beforeEach(() => {
    signInWithOAuth.mockReset();
    showToast.mockReset();
    signInWithOAuth.mockResolvedValue({
      data: { url: "https://accounts.google.com/o/oauth2/auth?client_id=test" },
      error: null,
    });
    stubLegacyIosShell();
    realLocation = window.location;
    navigations = recordNavigations();
  });

  afterEach(() => {
    restoreLocation(realLocation);
    cleanup();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    document.documentElement.removeAttribute("data-native");
    vi.resetModules();
  });

  it("renders the reason in place and never navigates the WebView", async () => {
    const { GoogleSignInButton } = await import("@/components/auth/google-sign-in-button");
    const { NATIVE_IOS_OAUTH_REBUILD_MESSAGE } = await import("@/lib/native/open-url");

    const errors: string[] = [];

    render(<GoogleSignInButton onError={(message) => errors.push(message)} />);
    fireEvent.click(screen.getByText("Continue with Google"));

    await waitFor(() => expect(errors).toContain(NATIVE_IOS_OAUTH_REBUILD_MESSAGE));

    // Inline slot owns the message — no bottom-right toast duplicate.
    expect(showToast).not.toHaveBeenCalled();
    // …and the page must still be the page: no reload, nothing typed thrown away.
    expect(navigations).toEqual([]);
    // The button has to come back, or the screen is stuck on "Redirecting…" forever.
    await waitFor(() => expect(screen.getByText("Continue with Google")).toBeTruthy());
  });

  it("never falls back to SFSafariViewController", async () => {
    const { GoogleSignInButton } = await import("@/components/auth/google-sign-in-button");
    const { Browser } = await import("@capacitor/browser");

    const errors: string[] = [];
    render(<GoogleSignInButton onError={(message) => errors.push(message)} />);
    fireEvent.click(screen.getByText("Continue with Google"));

    await waitFor(() => expect(errors.length).toBeGreaterThan(0));
    expect(Browser.open).not.toHaveBeenCalled();
  });
});
