import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const connected = { connected: true, email: "synthetic@example.test", refreshToken: "refresh-secret", accessToken: "access-secret" };

function database(mode: "column" | "row_data") {
  let connection: unknown = null;
  const upsert = vi.fn(async (value: Record<string, unknown>) => {
    connection = mode === "column" ? value.google_calendar : (value.row_data as Record<string, unknown>).google_calendar;
    return { error: null };
  });
  const db = { from: () => ({
    upsert,
    select: () => ({
      limit: async () => ({ error: mode === "column" ? null : { message: "google_calendar does not exist" } }),
      eq: () => ({ maybeSingle: async () => ({ error: null, data: {
        google_calendar: connection, row_data: { otherSetting: "preserved", google_calendar: connection },
      } }) }),
    }),
  }) } as unknown as SupabaseClient;
  return { db, upsert, set: (value: unknown) => { connection = value; }, get: () => connection as Record<string, string> };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.stubEnv("DATA_ENCRYPTION_REQUIRE_ENCRYPTED_READS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe.each(["column", "row_data"] as const)("Google token storage %s", (mode) => {
  it("encrypts both credentials, decrypts for server callers, and strips them from public status", async () => {
    const { saveGoogleCalendarConnection, loadGoogleCalendarConnection, googleCalendarPublicStatus } = await import("@/lib/google-calendar/settings");
    const store = database(mode);
    const result = await saveGoogleCalendarConnection(store.db, "manager-a", connected);
    expect(result.refreshToken).toBe(connected.refreshToken);
    expect(store.get().refreshToken).toMatch(/^proplane:v1:test:/);
    expect(store.get().accessToken).toMatch(/^proplane:v1:test:/);
    expect(JSON.stringify(store.get())).not.toContain("refresh-secret");
    const loaded = await loadGoogleCalendarConnection(store.db, "manager-a");
    expect(loaded.accessToken).toBe("access-secret");
    expect(googleCalendarPublicStatus(loaded)).not.toHaveProperty("accessToken");
    expect(googleCalendarPublicStatus(loaded)).not.toHaveProperty("refreshToken");
    if (mode === "row_data") expect(store.upsert.mock.calls[0][0].row_data).toHaveProperty("otherSetting", "preserved");
  });
  it("rejects moving tokens between managers or between token fields", async () => {
    const { saveGoogleCalendarConnection, loadGoogleCalendarConnection } = await import("@/lib/google-calendar/settings");
    const store = database(mode);
    await saveGoogleCalendarConnection(store.db, "manager-a", connected);
    await expect(loadGoogleCalendarConnection(store.db, "manager-b")).rejects.toThrow();
    const saved = store.get();
    store.set({ ...saved, refreshToken: saved.accessToken });
    await expect(loadGoogleCalendarConnection(store.db, "manager-a")).rejects.toThrow();
  });
  it("upgrades legacy plaintext on save and can reject remaining plaintext after migration", async () => {
    const { saveGoogleCalendarConnection, loadGoogleCalendarConnection } = await import("@/lib/google-calendar/settings");
    const store = database(mode);
    store.set(connected);
    await saveGoogleCalendarConnection(store.db, "manager-a", { syncEnabled: false });
    expect(store.get().refreshToken).toMatch(/^proplane:/);
    vi.stubEnv("DATA_ENCRYPTION_REQUIRE_ENCRYPTED_READS", "true");
    expect((await loadGoogleCalendarConnection(store.db, "manager-a")).refreshToken).toBe("refresh-secret");
    store.set(connected);
    await expect(loadGoogleCalendarConnection(store.db, "manager-a")).rejects.toThrow(/Unmigrated/);
  });
  it("never writes plaintext when keys are missing, but can still disconnect corrupted data", async () => {
    const { saveGoogleCalendarConnection, clearGoogleCalendarConnection } = await import("@/lib/google-calendar/settings");
    const store = database(mode);
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "");
    await expect(saveGoogleCalendarConnection(store.db, "manager-a", connected)).rejects.toThrow();
    expect(store.upsert).not.toHaveBeenCalled();
    store.set({ ...connected, refreshToken: "proplane:v99:bad", accessToken: "proplane:v99:bad" });
    await clearGoogleCalendarConnection(store.db, "manager-a");
    expect(store.get().refreshToken).toBeNull();
    expect(store.get().accessToken).toBeNull();
  });
});
