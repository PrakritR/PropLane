import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonResponse } from "../../helpers/api-request";

import { GET as oauthProviders } from "@/app/api/auth/oauth-providers/route";

describe("GET /api/auth/oauth-providers", () => {
  const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const prevKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const prevCanonical = process.env.NEXT_PUBLIC_CANONICAL_APP_URL;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = prevKey;
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = prevCanonical;
    vi.unstubAllGlobals();
  });

  it("returns null status when Supabase URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const res = await oauthProviders();
    const { status, data } = await parseJsonResponse<{
      googleEnabled: boolean | null;
      hint: string | null;
      httpsCallbackUrls: string[];
    }>(res);
    expect(status).toBe(200);
    expect(data.googleEnabled).toBeNull();
    expect(data.hint).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("reports googleEnabled from Supabase settings", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_test";
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = "https://axis.example";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            external: { google: false, email: true },
          }),
          { status: 200 },
        ),
      ),
    );

    const res = await oauthProviders();
    const { status, data } = await parseJsonResponse<{
      googleEnabled: boolean;
      supabaseUrl: string;
      googleRedirectUri: string;
      nativeCallbackUrls: string[];
      nativeRedirectHint: string;
      hint: string | null;
      googleRedirectHint: string | null;
    }>(res);

    expect(status).toBe(200);
    expect(data.googleEnabled).toBe(false);
    expect(data.supabaseUrl).toBe("https://example.supabase.co");
    expect(data.googleRedirectUri).toBe("https://example.supabase.co/auth/v1/callback");
    // The callback URLs moved out of the hint copy into their own
    // `httpsCallbackUrls` field; the hint now points at that list rather than
    // inlining one URL. Assert the URL where it actually lives.
    expect(data.httpsCallbackUrls).toContain("https://axis.example/auth/callback");
    expect(data.hint).toContain("httpsCallbackUrls");
    expect(data.nativeCallbackUrls[0]).toContain("space.proplane.app://auth/callback");
    expect(data.nativeRedirectHint).toContain("Redirect URLs");
    expect(data.googleRedirectHint).toContain("redirect_uri_mismatch");
  });

  it("returns null googleEnabled when settings fetch fails", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_test";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
    );

    const res = await oauthProviders();
    const { status, data } = await parseJsonResponse<{
      googleEnabled: boolean | null;
      hint: string | null;
    }>(res);

    expect(status).toBe(200);
    expect(data.googleEnabled).toBeNull();
    expect(data.hint).toContain("Could not read Supabase auth settings");
  });
});
