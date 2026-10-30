// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ resolve: vi.fn(), fallback: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("next=%2Fportal%2Fdashboard") }));
vi.mock("@/lib/auth/wait-for-oauth-user", () => ({ waitForOAuthUser: async () => ({ id: "manager" }) }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { refreshSession: async () => ({}), getSession: async () => ({ data: { session: { access_token: "synthetic" } } }) } }) }));
vi.mock("@/lib/auth/resolve-post-auth-destination", () => ({ resolvePostAuthDestination: m.resolve, resolveClientPostAuthDestination: m.fallback }));
import ContinuePage from "@/app/auth/continue/page";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows retry instead of a client-side manager portal fallback on server 503", async () => {
  m.resolve.mockResolvedValue({ redirectTo: null, resolutionFailed: true, serverUnavailable: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ role: null }) }));
  Object.defineProperty(window, "location", { configurable: true, value: { replace: m.replace } });
  render(<ContinuePage />);
  expect(await screen.findByText(/account access is temporarily unavailable/i)).toBeTruthy();
  expect(m.fallback).not.toHaveBeenCalled();
  expect(m.replace).not.toHaveBeenCalled();
});
