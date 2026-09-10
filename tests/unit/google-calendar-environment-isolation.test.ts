import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGoogleCalendarConnection } from "@/lib/google-calendar/settings";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("@/lib/security/data-encryption", () => ({
  isEncryptedSensitiveValue: () => false, decryptSensitiveValue: (v: string) => v,
  encryptSensitiveValue: (v: string) => v,
}));
function db(connection: object) {
  const q = { select: () => q, limit: async () => ({ error: null }), eq: () => q,
    maybeSingle: async () => ({ data: { google_calendar: connection }, error: null }) };
  return { from: () => q } as unknown as SupabaseClient;
}
afterEach(() => vi.unstubAllEnvs());
describe("copied calendar credentials", () => {
  const connected = { connected: true, refreshToken: "test-refresh", syncEnabled: true };
  it.each([undefined, "qahnczmilgptcedaqype"])("blocks cloned legacy/production credentials (%s) before any API call", async (projectRef) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://xwszcafaontidfgznlxd.supabase.co");
    const result = await loadGoogleCalendarConnection(db({ ...connected, projectRef }), "manager");
    expect(result.connected).toBe(false);
    expect(result.refreshToken).toBeNull();
    expect(result.syncEnabled).toBe(false);
  });
  it("allows an explicitly connected staging calendar", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://xwszcafaontidfgznlxd.supabase.co");
    vi.stubEnv("DATA_ENCRYPTION_REQUIRE_ENCRYPTED_READS", "false");
    expect((await loadGoogleCalendarConnection(db({ ...connected, projectRef: "xwszcafaontidfgznlxd" }), "manager")).connected).toBe(true);
  });
  it("preserves existing production connections", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qahnczmilgptcedaqype.supabase.co");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "production");
    vi.stubEnv("DATA_ENCRYPTION_REQUIRE_ENCRYPTED_READS", "false");
    expect((await loadGoogleCalendarConnection(db(connected), "manager")).connected).toBe(true);
  });
});
