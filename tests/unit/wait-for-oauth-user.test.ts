import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/with-timeout", () => ({
  AUTH_CALL_TIMEOUT_MS: 6000,
  withAuthTimeout: <T,>(promise: PromiseLike<T>) => Promise.resolve(promise),
}));

import { waitForOAuthUser } from "@/lib/auth/wait-for-oauth-user";

describe("waitForOAuthUser", () => {
  it("returns the user once getUser succeeds", async () => {
    const user = { id: "u1" };
    const supabase = {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValueOnce({ data: { user: null } })
          .mockResolvedValueOnce({ data: { user } }),
      },
    };

    const result = await waitForOAuthUser(supabase as never, { maxWaitMs: 500, delayMs: 1 });
    expect(result).toBe(user);
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(2);
  });

  it("returns null when getUser never resolves to a user", async () => {
    const supabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      },
    };

    const result = await waitForOAuthUser(supabase as never, { maxWaitMs: 50, delayMs: 1 });
    expect(result).toBeNull();
  });
});
