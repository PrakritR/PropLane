// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GoogleCalendarConnectPanel } from "@/components/portal/google-calendar-connect-panel";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

/**
 * Regression test for a real connect-reliability bug found while extending
 * this panel for vendor push: `disconnect()` and `toggleSync()` both
 * hardcoded `/api/portal/google-calendar` instead of using the `apiBase`
 * prop, so a vendor (`apiBase="/api/vendor/google-calendar"`) clicking
 * Disconnect or toggling sync silently hit the MANAGER's endpoint instead of
 * their own — a pure vendor account could never disconnect or turn sync off.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GoogleCalendarConnectPanel apiBase routing", () => {
  it("DELETEs the vendor's own apiBase, never the manager's, when a vendor clicks Disconnect", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method });
        if (init?.method === "DELETE") {
          return new Response(JSON.stringify({ connected: false, syncEnabled: false, configured: true }), { status: 200 });
        }
        // Every GET (the initial status load, and the reload after disconnect).
        return new Response(
          JSON.stringify({ connected: true, email: "vendor@example.com", syncEnabled: true, configured: true }),
          { status: 200 },
        );
      }),
    );

    render(
      <AppUiProvider>
        <GoogleCalendarConnectPanel apiBase="/api/vendor/google-calendar" />
      </AppUiProvider>,
    );

    await waitFor(() => expect(screen.getByText("Disconnect")).toBeTruthy());
    fireEvent.click(screen.getByText("Disconnect"));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    const deleteCall = calls.find((c) => c.method === "DELETE");
    expect(deleteCall?.url).toContain("/api/vendor/google-calendar");
    expect(deleteCall?.url).not.toContain("/api/portal/google-calendar");
  });

  it("PATCHes the vendor's own apiBase, never the manager's, when a vendor toggles sync", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method, body: init?.body as string | undefined });
        if (init?.method === "PATCH") {
          return new Response(JSON.stringify({ connected: true, syncEnabled: false, configured: true }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ connected: true, email: "vendor@example.com", syncEnabled: true, configured: true }),
          { status: 200 },
        );
      }),
    );

    render(
      <AppUiProvider>
        <GoogleCalendarConnectPanel apiBase="/api/vendor/google-calendar" />
      </AppUiProvider>,
    );

    const checkbox = await waitFor(() => {
      const el = document.querySelector('[data-attr="google-calendar-sync-toggle"]');
      if (!el) throw new Error("toggle not rendered yet");
      return el as HTMLInputElement;
    });
    fireEvent.click(checkbox);

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patchCall = calls.find((c) => c.method === "PATCH");
    expect(patchCall?.url).toContain("/api/vendor/google-calendar");
    expect(patchCall?.url).not.toContain("/api/portal/google-calendar");
  });
});
