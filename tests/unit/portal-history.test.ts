/**
 * `canGoBackInApp`: a Back control may call `history.back()` only when an earlier PropLane screen exists.
 * On a deep link it would leave the site, so the caller shows its own list instead.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { canGoBackInApp } from "@/lib/portal-history";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("canGoBackInApp", () => {
  it("trusts the Navigation API when the browser has one", () => {
    vi.stubGlobal("navigation", { canGoBack: false });
    expect(canGoBackInApp()).toBe(false);
    vi.stubGlobal("navigation", { canGoBack: true });
    expect(canGoBackInApp()).toBe(true);
  });

  it("without it, needs history and a same-origin referrer (a deep link has neither)", () => {
    vi.stubGlobal("navigation", undefined);
    vi.spyOn(window.history, "length", "get").mockReturnValue(1);
    expect(canGoBackInApp()).toBe(false);
    vi.spyOn(window.history, "length", "get").mockReturnValue(4);
    vi.spyOn(document, "referrer", "get").mockReturnValue("https://elsewhere.example/page");
    expect(canGoBackInApp()).toBe(false);
    vi.spyOn(document, "referrer", "get").mockReturnValue(`${window.location.origin}/admin/dashboard`);
    expect(canGoBackInApp()).toBe(true);
  });
});
