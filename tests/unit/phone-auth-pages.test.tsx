import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("phone auth page mode and identity gates", () => {
  it.each(["per_workspace", "shadow"])("keeps phone sign-in off in %s", async (mode) => {
    loadConfig.mockResolvedValue({ mode });
    expect((await SignInPage()).props.phoneFirst).toBe(false);
  });
  it("shows phone sign-in first in shared mode", async () => {
    loadConfig.mockResolvedValue({ mode: "shared" });
    expect((await SignInPage()).props.phoneFirst).toBe(true);
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
