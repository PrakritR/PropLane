import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, abortSignal } = vi.hoisted(() => ({ rpc: vi.fn(), abortSignal: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc }) }));
import { rateLimit } from "@/lib/rate-limit";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only-service-key");
  rpc.mockReset().mockReturnValue({ abortSignal });
  abortSignal.mockReset().mockResolvedValue({ data: true, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("shared rate limits", () => {
  it("uses only the atomic server RPC and a pseudonymous key", async () => {
    expect(await rateLimit("password-reset:email:person@example.test", 3, 60_000)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_bucket_key: expect.stringMatching(/^[a-f0-9]{64}$/), p_limit: 3, p_window_ms: 60_000,
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("person@example.test");
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
  it("separates identities and policy windows but shares identical buckets", async () => {
    for (const [key, window] of [["a", 1000], ["a", 1000], ["b", 1000], ["a", 2000]] as const) {
      await rateLimit(key, 3, window);
    }
    const keys = rpc.mock.calls.map((args) => args[1].p_bucket_key);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });
  it("honors shared exhaustion even on the first local call", async () => {
    abortSignal.mockResolvedValue({ data: false, error: null });
    expect(await rateLimit("new-instance", 3, 60_000)).toEqual({ ok: false });
  });
  it.each([
    { data: null, error: { message: "private-provider-details" } },
    { data: "true", error: null },
    { data: null, error: null },
  ])("fails closed on RPC errors or malformed results", async (result) => {
    abortSignal.mockResolvedValue(result);
    expect(await rateLimit("private-person", 3, 60_000)).toEqual({ ok: false, unavailable: true });
    expect(console.error).toHaveBeenCalledWith("[security] shared_rate_limit_unavailable");
  });
  it("fails closed on network/timeout errors", async () => {
    abortSignal.mockRejectedValue(new Error("private-provider-details"));
    expect(await rateLimit("a", 3, 60_000)).toEqual({ ok: false, unavailable: true });
  });
  it("fails closed when deployment credentials are missing", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(await rateLimit("a", 3, 60_000)).toEqual({ ok: false, unavailable: true });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("uses the shared store for preview builds too", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "preview");
    await rateLimit("preview", 3, 60_000);
    expect(rpc).toHaveBeenCalledOnce();
  });
  it.each([0, -1, NaN, Infinity, 1.5, 100001])("rejects invalid limits %s", async (limit) => {
    await expect(rateLimit("a", limit, 1000)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
