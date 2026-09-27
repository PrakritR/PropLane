/**
 * `/api/manager/app-download-email` — N068's "Email me the link" control.
 * The route takes NO destination from the request: it always sends the fixed
 * download URL to the signed-in manager's own account email, so it can never
 * become a relay to an arbitrary address (the SMS version this replaced let
 * any signed-in account text an arbitrary worldwide number).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPortalAccessContext: vi.fn(),
  postResendEmail: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: mocks.getPortalAccessContext,
  hasRole: (ctx: { roles: string[] }, role: string) => ctx.roles.includes(role),
}));
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: mocks.postResendEmail,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/lib/ios-app-download", () => ({
  iosAppDownloadUrl: () => "https://apps.apple.com/us/app/proplane/id123",
}));

const { POST } = await import("@/app/api/manager/app-download-email/route");

function managerCtx(overrides: Partial<{ email: string | null; roles: string[] }> = {}) {
  return {
    user: { id: "user-1", email: overrides.email ?? "manager@example.com" },
    profile: null,
    roles: overrides.roles ?? ["manager"],
    effectiveRole: "manager",
  };
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  mocks.getPortalAccessContext.mockReset().mockResolvedValue(managerCtx());
  mocks.rateLimit.mockReset().mockResolvedValue({ ok: true });
  mocks.postResendEmail.mockReset().mockResolvedValue({ ok: true, json: async () => ({ id: "email_1" }) });
});

describe("POST /api/manager/app-download-email", () => {
  it("401s when signed out", async () => {
    mocks.getPortalAccessContext.mockResolvedValue({ user: null, profile: null, roles: [], effectiveRole: null });
    const res = await POST();
    expect(res.status).toBe(401);
    expect(mocks.postResendEmail).not.toHaveBeenCalled();
  });

  it("403s a non-manager account", async () => {
    mocks.getPortalAccessContext.mockResolvedValue(managerCtx({ roles: ["resident"] }));
    const res = await POST();
    expect(res.status).toBe(403);
    expect(mocks.postResendEmail).not.toHaveBeenCalled();
  });

  it("emails the fixed download link to the signed-in account's own email", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mocks.postResendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "user-1",
        payload: expect.objectContaining({
          to: ["manager@example.com"],
          text: expect.stringContaining("https://apps.apple.com/us/app/proplane/id123"),
        }),
      }),
    );
  });

  it("never takes a destination from the request body", async () => {
    // The handler takes no Request argument at all — nothing in a body can
    // ever reach the recipient list.
    expect(POST.length).toBe(0);
  });

  it("429s once the per-account throttle is exhausted", async () => {
    mocks.rateLimit.mockResolvedValue({ ok: false });
    const res = await POST();
    expect(res.status).toBe(429);
    expect(mocks.postResendEmail).not.toHaveBeenCalled();
  });

  it("503s when email delivery isn't configured", async () => {
    delete process.env.RESEND_API_KEY;
    const res = await POST();
    expect(res.status).toBe(503);
    expect(mocks.postResendEmail).not.toHaveBeenCalled();
  });

  it("502s when the provider send fails", async () => {
    mocks.postResendEmail.mockResolvedValue({ ok: false, json: async () => ({}) });
    const res = await POST();
    expect(res.status).toBe(502);
  });
});
