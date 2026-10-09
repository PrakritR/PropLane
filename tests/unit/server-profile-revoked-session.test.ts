import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const signOut = vi.fn();

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser, signOut } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/auth/session-rejection", () => ({ describeAuthRejection: vi.fn(async () => undefined) }));

import { getServerSessionProfile } from "@/lib/auth/server-profile";

function authError(message: string, extra: { code?: string; status?: number } = {}) {
  return Object.assign(new Error(message), extra);
}

describe("getServerSessionProfile revoked sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signOut.mockResolvedValue({ error: null });
  });

  it("signs out locally when getUser() reports a revoked session", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: authError("gone", { code: "session_not_found", status: 403 }) });
    await expect(getServerSessionProfile()).resolves.toEqual({ user: null, profile: null });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("keeps the cookies on a rotation race, a 429 or a 5xx", async () => {
    for (const error of [
      authError("used", { code: "refresh_token_already_used", status: 400 }),
      authError("rate limited", { status: 429 }),
      authError("upstream", { status: 503 }),
      new TypeError("Failed to fetch"),
    ]) {
      getUser.mockResolvedValueOnce({ data: { user: null }, error });
      await getServerSessionProfile();
    }
    expect(signOut).not.toHaveBeenCalled();
  });
});
