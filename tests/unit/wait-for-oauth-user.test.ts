// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForOAuthUser } from "@/lib/auth/wait-for-oauth-user";

describe("waitForOAuthUser", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("ends a hanging auth call at the remaining wall-clock deadline", async () => {
    vi.useFakeTimers();
    const supabase = {
      auth: {
        getUser: vi.fn().mockReturnValue(new Promise(() => undefined)),
      },
    };

    const result = waitForOAuthUser(supabase as never, { attempts: 1, maxWaitMs: 100 });
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void result.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeNull();
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);
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
