import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  publicTextingConfig,
  SMS_DEMO_BODY,
} from "@/lib/marketing/public-texting";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  select: vi.fn(),
  abort: vi.fn(),
  client: null as SupabaseClient | null,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () =>
    mocks.client ?? {
      from: () => ({
        select: (columns: string) => {
          mocks.select(columns);
          return {
            eq: () => ({
              abortSignal: (signal: AbortSignal) => {
                mocks.abort(signal);
                return { maybeSingle: () => mocks.read() };
              },
            }),
          };
        },
      }),
    },
}));
vi.mock("@/lib/server-ttl-cache", async (original) => ({
  ...(await original<typeof import("@/lib/server-ttl-cache")>()),
  serverSnapshotCacheEnabled: () => true,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.client = null;
});

describe("public texting configuration", () => {
  it("builds a real SMS destination with the plain greeting", () => {
    const config = publicTextingConfig("+12065550123");
    expect(config.phone).toBe("+12065550123");
    expect(config.smsHref).toBe(
      `sms:+12065550123?&body=${encodeURIComponent(SMS_DEMO_BODY)}`,
    );
    expect(new URLSearchParams(config.smsHref!.split("?")[1]).get("body")).toBe(
      "Hi PropLane",
    );
  });

  it.each([null, undefined, "", "bad"])(
    "never invents a destination for %s",
    (value) => {
      expect(publicTextingConfig(value)).toEqual({
        phone: null,
        smsHref: null,
      });
    },
  );

  it("coalesces public reads and caches the same narrow projection", async () => {
    mocks.read.mockResolvedValue({
      data: { line_mode: "shared", shared_number_e164: "+12065550123" },
      error: null,
    });
    const { getPublicTextingConfig } =
      await import("@/lib/marketing/public-texting.server");
    const [first, second] = await Promise.all([
      getPublicTextingConfig(),
      getPublicTextingConfig(),
    ]);
    expect(first).toEqual(second);
    expect(first.phone).toBe("+12065550123");
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.select).toHaveBeenCalledWith("line_mode,shared_number_e164");
    expect(mocks.abort.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    await getPublicTextingConfig();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("executes the deadline and singleton read through the real installed Supabase builder", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            line_mode: "shared",
            shared_number_e164: "+12065550123",
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    mocks.client = createClient(
      "https://example.supabase.co",
      "unit-test-key",
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch },
      },
    );
    const { getPublicTextingConfig } =
      await import("@/lib/marketing/public-texting.server");
    expect((await getPublicTextingConfig()).phone).toBe("+12065550123");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["per_workspace", "unknown"])(
    "does not advertise an inactive shared sender in %s mode",
    async (mode) => {
      mocks.read.mockResolvedValue({
        data: { line_mode: mode, shared_number_e164: "+12065550123" },
        error: null,
      });
      const { getPublicTextingConfig } =
        await import("@/lib/marketing/public-texting.server");
      expect(await getPublicTextingConfig()).toEqual({
        phone: null,
        smsHref: null,
      });
    },
  );

  it("advertises the configured public number in captain-approved shadow mode", async () => {
    mocks.read.mockResolvedValue({
      data: { line_mode: "shadow", shared_number_e164: "+12065550123" },
      error: null,
    });
    const { getPublicTextingConfig } =
      await import("@/lib/marketing/public-texting.server");
    expect((await getPublicTextingConfig()).phone).toBe("+12065550123");
  });

  it("falls back on unavailable schema without caching the failure", async () => {
    mocks.read
      .mockResolvedValueOnce({ data: null, error: { code: "42703" } })
      .mockResolvedValueOnce({
        data: { line_mode: "shared", shared_number_e164: "+12065550123" },
        error: null,
      });
    const { getPublicTextingConfig } =
      await import("@/lib/marketing/public-texting.server");
    expect(await getPublicTextingConfig()).toEqual({
      phone: null,
      smsHref: null,
    });
    expect((await getPublicTextingConfig()).phone).toBe("+12065550123");
  });
});
