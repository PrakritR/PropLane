import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfig, createService, getUser, redirect } = vi.hoisted(() => ({
  loadConfig: vi.fn(), createService: vi.fn(), getUser: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: loadConfig }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: createService }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/components/auth/native-auth-hub", () => ({ NativeAuthHub: () => null }));
vi.mock("@/components/auth/phone-auth-form", () => ({ PhoneAuthForm: () => null }));

import SignInPage from "@/app/auth/sign-in/page";
import VerifyPhonePage from "@/app/auth/verify-phone/page";

beforeEach(() => {
  createService.mockReset().mockReturnValue({});
  loadConfig.mockReset().mockResolvedValue({ mode: "per_workspace" });
  getUser.mockReset().mockResolvedValue({ data: { user: { id: "signed-in" } } });
  redirect.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("phone auth page mode and identity gates", () => {
  it.each(["per_workspace", "shadow"])("keeps phone sign-in off in %s", async (mode) => {
    loadConfig.mockResolvedValue({ mode });
    expect((await SignInPage()).props.phoneFirst).toBe(false);
  });
  it("shows phone sign-in first in shared mode", async () => {
    loadConfig.mockResolvedValue({ mode: "shared" });
    expect((await SignInPage()).props.phoneFirst).toBe(true);
  });
  it("returns the legacy surface after 1500ms when the preference read stalls", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    loadConfig.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const page = SignInPage();
    await vi.advanceTimersByTimeAsync(1500);
    expect((await page).props.phoneFirst).toBe(false);
    reject(new Error("late failure"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not change the returned mode when a stalled read resolves late", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { mode: string }) => void;
    loadConfig.mockReturnValue(new Promise((done) => { resolve = done; }));
    const page = SignInPage();
    await vi.advanceTimersByTimeAsync(1500);
    const result = await page;
    expect(result.props.phoneFirst).toBe(false);
    resolve({ mode: "shared" });
    await Promise.resolve();
    expect(result.props.phoneFirst).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the timeout when the preference resolves or rejects promptly", async () => {
    vi.useFakeTimers();
    loadConfig.mockResolvedValueOnce({ mode: "shared" }).mockRejectedValueOnce(new Error("unavailable"));
    expect((await SignInPage()).props.phoneFirst).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect((await SignInPage()).props.phoneFirst).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps legacy sign-in accessible when service credentials are unavailable", async () => {
    createService.mockImplementation(() => { throw new Error("unavailable"); });
    expect((await SignInPage()).props.phoneFirst).toBe(false);
  });
  it("requires a session before attaching a verified phone", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    await expect(VerifyPhonePage({ searchParams: Promise.resolve({ next: "/vendor/jobs" }) })).rejects.toThrow("redirect:/auth/sign-in?next=%2Fvendor%2Fjobs");
    expect(loadConfig).not.toHaveBeenCalled();
  });
  it("does not introduce a verification step outside shared mode", async () => {
    await expect(VerifyPhonePage({ searchParams: Promise.resolve({ next: "/vendor/jobs" }) })).rejects.toThrow("redirect:/auth/continue?next=%2Fvendor%2Fjobs");
  });
  it("renders verification for authenticated shared-mode accounts without invoking the portal gate", async () => {
    loadConfig.mockResolvedValue({ mode: "shared" });
    expect(await VerifyPhonePage({ searchParams: Promise.resolve({}) })).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });
});
