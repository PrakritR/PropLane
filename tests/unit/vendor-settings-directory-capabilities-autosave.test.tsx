// @vitest-environment jsdom
//
// VD02/VD03/VD08/VD09: Directory listing and Work capabilities autosave —
// no Save button, "Saving…"/"Saved" beside the section title, and an invalid
// email shows an inline error under the field without being saved while the
// typed value is kept.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let currentTab = "profile";

vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/profile",
  useSearchParams: () => new URLSearchParams(`tab=${currentTab}`),
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

function mockFetchByUrl(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) return { ok: true, status: 200, json: async () => ({}) };
      const entry = routes[key];
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const result = typeof entry === "function" ? entry(body) : entry;
      const status = typeof result === "object" && result && "status" in result ? (result as { status: number }).status : 200;
      return { ok: status < 400, status, json: async () => result };
    }),
  );
}

async function waitForElement<T extends Element>(selector: string): Promise<T> {
  return waitFor(() => {
    const el = document.querySelector(selector) as T | null;
    expect(el).not.toBeNull();
    return el as T;
  });
}

describe("Directory listing — autosave and inline validation", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("saves a valid business-name edit on blur with no Save button anywhere", async () => {
    currentTab = "profile";
    let lastPatch: unknown;
    mockFetchByUrl({
      "/api/vendor/business-profile": { profile: {}, workspaces: [] },
      "/api/vendor/profile": (body: unknown) => {
        // GET (no body) loads the ORIGINAL empty name; only the later PATCH
        // carries the edit — echoing the new value back from the GET too
        // would make the autosave a same-value no-op that never calls save.
        if (body === undefined) return { profile: { name: "", phone: "", email: "", trades: [] } };
        lastPatch = body;
        return { profile: { name: "Apex Plumbing Co", phone: "", email: "", trades: [] } };
      },
    });
    render(<VendorSettingsPanel />);
    await waitForElement('[data-attr="vendor-settings-name"]');
    // Retries the whole type-and-blur interaction, not just the lookup — the
    // panel also has an independent business-profile fetch in flight, and a
    // single fire-and-check can race a re-render that replaces this input.
    await waitFor(() => {
      const named = document.querySelector('[data-attr="vendor-settings-name"]') as HTMLInputElement | null;
      if (!named) throw new Error("input not rendered yet");
      fireEvent.change(named, { target: { value: "Apex Plumbing Co" } });
      fireEvent.blur(named);
      expect(lastPatch).toEqual({ name: "Apex Plumbing Co" });
    });
    expect(document.querySelector('[data-attr="vendor-settings-profile-save"]')).toBeNull();
  });

  it("an invalid email shows an inline error, is never saved, and keeps the typed value", async () => {
    currentTab = "profile";
    let emailPatchCalls = 0;
    mockFetchByUrl({
      "/api/vendor/business-profile": { profile: {}, workspaces: [] },
      "/api/vendor/profile": (body: unknown) => {
        if (body && typeof body === "object" && "email" in body) emailPatchCalls += 1;
        return { profile: {} };
      },
    });
    render(<VendorSettingsPanel />);
    const emailInput = await waitForElement<HTMLInputElement>('[data-attr="vendor-settings-email"]');
    fireEvent.change(emailInput, { target: { value: "not-an-email" } });
    fireEvent.blur(emailInput);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Enter a valid email address.");
    });
    expect(emailPatchCalls).toBe(0);
    expect(emailInput.value).toBe("not-an-email");
  });

  it("restoring the original email value after an invalid entry clears the error without sending a save request", async () => {
    currentTab = "profile";
    let emailPatchCalls = 0;
    mockFetchByUrl({
      "/api/vendor/business-profile": { profile: {}, workspaces: [] },
      "/api/vendor/profile": (body: unknown) => {
        if (body && typeof body === "object" && "email" in body) emailPatchCalls += 1;
        // Initial load returns empty email; PATCH returns the new value
        if (body === undefined) return { profile: { name: "", phone: "", email: "", trades: [] } };
        return { profile: { name: "", phone: "", email: "", trades: [] } };
      },
    });
    render(<VendorSettingsPanel />);
    const emailInput = await waitForElement<HTMLInputElement>('[data-attr="vendor-settings-email"]');

    // Step 1: Type an invalid email and blur to show the error
    fireEvent.change(emailInput, { target: { value: "not-an-email" } });
    fireEvent.blur(emailInput);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Enter a valid email address.");
    });

    // Step 2: Restore the original empty value and blur — error should disappear
    fireEvent.change(emailInput, { target: { value: "" } });
    fireEvent.blur(emailInput);

    // The error text should be gone (restored to original value clears error)
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("Enter a valid email address.");
    });

    // No PATCH should have been sent (value equals saved value)
    expect(emailPatchCalls).toBe(0);
    expect(emailInput.value).toBe("");
  });
});

describe("Work capabilities — immediate autosave on toggle", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("saves a trade immediately on checkbox change, no Save button", async () => {
    currentTab = "capabilities";
    let lastTrades: string[] | undefined;
    mockFetchByUrl({
      "/api/vendor/business-profile": { profile: {}, workspaces: [] },
      "/api/vendor/profile": (body: unknown) => {
        const b = body as { trades?: string[] } | undefined;
        if (b?.trades) lastTrades = b.trades;
        return { profile: { trades: b?.trades ?? [] } };
      },
    });
    render(<VendorSettingsPanel />);
    const box = await waitForElement<HTMLInputElement>('[data-vs-trades] input[type="checkbox"]');
    fireEvent.click(box);
    await waitFor(() => expect(lastTrades).toBeDefined());
    expect(document.querySelector('[data-attr="vendor-settings-capabilities-save"]')).toBeNull();
  });
});
