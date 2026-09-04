/**
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AuthTimeoutError, withAuthTimeout } from "@/lib/auth/with-timeout";

/**
 * After creating an account the signup forms signed the user in and awaited it
 * with NO timeout. When that call fails at the network level — flaky
 * connection, captive-portal wifi, a blocking extension — the promise never
 * settles, the `finally` that clears the busy flag never runs, and the button
 * stays `aria-busy` forever with no message. The account exists; the person is
 * told nothing, concludes it failed, and retries into "already registered"
 * (PRP-187).
 */
describe("withAuthTimeout", () => {
  it("resolves normally when the call settles in time", async () => {
    await expect(withAuthTimeout(Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });

  it("rejects rather than hanging when the call never settles", async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    const raced = withAuthTimeout(never, 6000);
    const assertion = expect(raced).rejects.toBeInstanceOf(AuthTimeoutError);
    await vi.advanceTimersByTimeAsync(6001);
    await assertion;
    vi.useRealTimers();
  });

  it("clears its timer, so a settled call leaves nothing pending", async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(window, "clearTimeout");
    await withAuthTimeout(Promise.resolve(1), 6000);
    expect(clear).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("passes the original rejection through untouched", async () => {
    const boom = new Error("refused");
    await expect(withAuthTimeout(Promise.reject(boom), 50)).rejects.toBe(boom);
  });
});

describe("no signup form awaits a sign-in that can hang", () => {
  const AUTH_DIR = join(process.cwd(), "src/components/auth");

  it("every signup form's post-create sign-in is bounded", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(AUTH_DIR).filter((f) => f.endsWith("signup-form.tsx") || f.endsWith("signup-panel.tsx"))) {
      const source = readFileSync(join(AUTH_DIR, file), "utf8");
      if (!source.includes("signInWithPassword")) continue;
      // The call must be inside withAuthTimeout, not awaited bare.
      if (/await supabase\.auth\.signInWithPassword/.test(source)) offenders.push(file);
      if (!source.includes("withAuthTimeout")) offenders.push(`${file} (no timeout import)`);
    }
    expect(offenders).toEqual([]);
  });

  it("a stall is handled the same way a refusal is", () => {
    // Both must reach the "account created, sign in to continue" fallback —
    // silently swallowing the timeout would put the spinner back.
    const source = readFileSync(join(AUTH_DIR, "manager-trial-signup-form.tsx"), "utf8");
    expect(source).toContain("catch (timeoutOrNetwork)");
    expect(source).toContain("signInError = timeoutOrNetwork");
    expect(source).toContain("Account created. Sign in to continue.");
  });
});
