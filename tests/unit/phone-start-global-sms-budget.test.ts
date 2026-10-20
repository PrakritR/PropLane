/**
 * Every door that texts a phone sign-in code takes from ONE endpoint-wide hourly budget. `/api/auth/phone/start`
 * had it; `/api/start/<token>/send`, which reaches the same `startPhoneChallenge` (including the branch that
 * texts a caller-supplied number), did not — so a second door could spend SMS outside the ceiling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({ ok: true })),
  startPhoneChallenge: vi.fn(async () => ({ ok: true })),
  resolveSetupLink: vi.fn(async () => ({ phoneKey: "2065550100" })),
  allowLinkRequest: vi.fn(async () => true),
  cookieJar: { get: vi.fn(() => undefined), set: vi.fn() },
}));

vi.mock("next/headers", () => ({ cookies: async () => mocks.cookieJar }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit, clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/auth/phone-auth.server", () => ({
  PHONE_AUTH_ERROR: "That did not work.",
  PHONE_BROWSER_COOKIE: "pb",
  newPhoneBrowserSecret: () => "secret",
  startPhoneChallenge: mocks.startPhoneChallenge,
}));
vi.mock("@/lib/one-number/link-http.server", () => ({
  allowLinkRequest: mocks.allowLinkRequest,
  expiredLinkResponse: () => new Response(JSON.stringify({ error: "expired" }), { status: 410 }),
}));
vi.mock("@/lib/one-number/onboarding/setup-links.server", () => ({ resolveSetupLink: mocks.resolveSetupLink }));
vi.mock("@/lib/one-number/unassigned-leads.server", () => ({ e164FromPhoneKey: (key: string) => `+1${key}` }));

import { PHONE_START_GLOBAL_PER_HOUR } from "@/lib/auth/phone-auth-request.server";

const GLOBAL_KEY = "phone-auth-start-global";

const sendSetupCode = async () => {
  const { POST } = await import("@/app/api/start/[token]/send/route");
  return POST(
    new Request("http://localhost/api/start/tok-1/send", { method: "POST", body: JSON.stringify({}) }),
    { params: Promise.resolve({ token: "tok-1" }) },
  );
};

const startPhoneCode = async () => {
  const { POST } = await import("@/app/api/auth/phone/start/route");
  return POST(
    new Request("http://localhost/api/auth/phone/start", {
      method: "POST",
      body: JSON.stringify({ purpose: "sign_in", phone: "+12065550100" }),
    }),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({ ok: true });
  mocks.allowLinkRequest.mockResolvedValue(true);
  mocks.startPhoneChallenge.mockResolvedValue({ ok: true });
  mocks.resolveSetupLink.mockResolvedValue({ phoneKey: "2065550100" });
});

describe("the endpoint-wide hourly SMS budget", () => {
  it("is 300 texts an hour, under ONE shared key", () => {
    expect(PHONE_START_GLOBAL_PER_HOUR).toBe(300);
  });

  it("is taken by the setup-link door too, with the same key and ceiling", async () => {
    await sendSetupCode();
    expect(mocks.rateLimit).toHaveBeenCalledWith(GLOBAL_KEY, PHONE_START_GLOBAL_PER_HOUR, 60 * 60 * 1000);
    expect(mocks.startPhoneChallenge).toHaveBeenCalledOnce();
  });

  it("refuses the setup-link door once the budget is gone, and texts nothing", async () => {
    mocks.rateLimit.mockImplementation(async (key: string) => ({ ok: key !== GLOBAL_KEY }));
    const response = await sendSetupCode();
    expect(response.status).toBe(400);
    expect(mocks.startPhoneChallenge).not.toHaveBeenCalled();
  });

  it("is the same key the main phone-start door takes, so the two share one ceiling", async () => {
    await startPhoneCode();
    expect(mocks.rateLimit).toHaveBeenCalledWith(GLOBAL_KEY, PHONE_START_GLOBAL_PER_HOUR, 60 * 60 * 1000);
  });
});
