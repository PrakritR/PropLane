import { afterEach, describe, expect, it, vi } from "vitest";

const { withAuthTimeout } = vi.hoisted(() => ({
  withAuthTimeout: vi.fn(<T,>(promise: PromiseLike<T>) => Promise.resolve(promise)),
}));

vi.mock("@/lib/auth/with-timeout", () => ({
  AUTH_CALL_TIMEOUT_MS: 6000,
  withAuthTimeout,
}));

import { waitForOAuthUser } from "@/lib/auth/wait-for-oauth-user";

describe("waitForOAuthUser", () => {
  afterEach(() => {
    withAuthTimeout.mockClear();
    vi.restoreAllMocks();
  });

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

  it("honors an explicit attempt cap even when the wall-clock budget remains", async () => {
    const supabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      },
    };

    await expect(
      waitForOAuthUser(supabase as never, { attempts: 2, maxWaitMs: 500, delayMs: 0 }),
    ).resolves.toBeNull();
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(2);
  });

  it("clamps each auth call to the remaining wall-clock budget", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const supabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      },
    };

    await waitForOAuthUser(supabase as never, { attempts: 1, maxWaitMs: 100 });
    expect(withAuthTimeout).toHaveBeenCalledWith(expect.any(Promise), 100);
  });

  it("does not begin another auth call after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const supabase = {
      auth: { getUser: vi.fn() },
    };

    await expect(
      waitForOAuthUser(supabase as never, { attempts: 2, signal: controller.signal }),
    ).resolves.toBeNull();
    expect(supabase.auth.getUser).not.toHaveBeenCalled();
  });

  it("removes its abort listener when an auth call settles", async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const supabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    };

    await waitForOAuthUser(supabase as never, {
      attempts: 1,
      signal: controller.signal,
    });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
