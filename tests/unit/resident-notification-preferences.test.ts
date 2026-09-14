/**
 * `notification_preferences` has RLS enabled with no policies (service-role
 * only), so `/api/portal/resident-notification-preferences` is the only path
 * a resident has to read or change their own row. These tests pin the four
 * guarantees the route exists to enforce: the in-app inbox can never be
 * turned off, a save for one category never resets any other category back
 * to its defaults, the row acted on is always the caller's own session
 * (never a `user_id` supplied by the caller), and a caller who does not hold
 * the resident role is refused — off `profile_roles`, never the legacy
 * `profiles.role` column.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@/lib/notification-preferences";

const RESIDENT_ID = "user-resident";
const RESIDENT_EMAIL = "resident@example.com";
const OTHER_ID = "user-other";

type ProfileRow = { role: string | null; phone?: string | null; sms_opt_out_at?: string | null; sms_consent_at?: string | null };
type SmsConsentRow = { opted_in_at?: string | null; opted_out_at?: string | null };

let PROFILES: Record<string, ProfileRow> = {};
let PROFILE_ROLES: Record<string, string[]> = {};
let NOTIFICATION_PREFS: Record<string, unknown> = {};
let SMS_CONSENT: Record<string, SmsConsentRow> = {};

const getUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

type Row = Record<string, unknown>;

function tableRows(table: string): Row[] {
  if (table === "profiles") {
    return Object.entries(PROFILES).map(([id, row]) => ({ id, ...row }));
  }
  if (table === "profile_roles") {
    const out: Row[] = [];
    for (const [userId, roles] of Object.entries(PROFILE_ROLES)) {
      for (const role of roles) out.push({ user_id: userId, role });
    }
    return out;
  }
  if (table === "notification_preferences") {
    return Object.entries(NOTIFICATION_PREFS).map(([user_id, row_data]) => ({ user_id, row_data }));
  }
  if (table === "sms_consent") {
    return Object.entries(SMS_CONSENT).map(([phone, row]) => ({ phone, ...row }));
  }
  return [];
}

function makeDb() {
  function builder(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const api = {
      select() {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push((row) => row[col] === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push((row) => vals.includes(row[col]));
        return api;
      },
      async maybeSingle() {
        const match = tableRows(table).find((row) => filters.every((f) => f(row)));
        return { data: match ?? null, error: null };
      },
      async upsert(payload: Row) {
        if (table === "notification_preferences") {
          NOTIFICATION_PREFS[String(payload.user_id)] = payload.row_data;
        }
        return { error: null };
      },
    };
    return api;
  }
  return { from: (t: string) => builder(t) };
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, body === undefined ? { method } : { method, body: JSON.stringify(body) });
}

async function get() {
  const { GET } = await import("@/app/api/portal/resident-notification-preferences/route");
  return GET();
}

async function patch(body: unknown, url = "http://localhost/api/portal/resident-notification-preferences") {
  const { PATCH } = await import("@/app/api/portal/resident-notification-preferences/route");
  return PATCH(jsonRequest(url, "PATCH", body));
}

beforeEach(() => {
  vi.clearAllMocks();
  PROFILES = {
    [RESIDENT_ID]: { role: "resident", phone: null },
  };
  PROFILE_ROLES = {};
  NOTIFICATION_PREFS = {};
  SMS_CONSENT = {};
  getUser.mockResolvedValue({ data: { user: { id: RESIDENT_ID, email: RESIDENT_EMAIL } }, error: null });
});

describe("GET /api/portal/resident-notification-preferences", () => {
  it("returns every category defaulted to on for an unset resident", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preferences: Record<string, { inbox: boolean; email: boolean; sms: boolean }> };
    expect(body.preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("refuses a caller holding no resident role", async () => {
    PROFILES[RESIDENT_ID] = { role: "manager" };
    PROFILE_ROLES[RESIDENT_ID] = ["manager"];
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Residents only." });
  });

  it("still allows a legacy resident with no profile_roles row", async () => {
    PROFILES[RESIDENT_ID] = { role: "resident" };
    const res = await get();
    expect(res.status).toBe(200);
  });

  it("answers 401 when unauthenticated", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await get();
    expect(res.status).toBe(401);
  });

  it("surfaces the STOP state when the resident's phone opted out", async () => {
    PROFILES[RESIDENT_ID] = { role: "resident", phone: "5551234567" };
    SMS_CONSENT["5551234567"] = { opted_in_at: null, opted_out_at: "2026-01-01T00:00:00.000Z" };
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sms: { available: boolean; reason?: string; message?: string } };
    expect(body.sms.available).toBe(false);
    expect(body.sms.reason).toBe("opted_out");
    expect(body.sms.message).toMatch(/START/);
  });

  it("reports SMS unavailable with a no_phone reason when no phone is on file", async () => {
    const res = await get();
    const body = (await res.json()) as { sms: { available: boolean; reason?: string } };
    expect(body.sms).toEqual({ available: false, reason: "no_phone" });
  });

  it("reports SMS available for a clean, non-opted-out phone", async () => {
    PROFILES[RESIDENT_ID] = { role: "resident", phone: "5559998888" };
    const res = await get();
    const body = (await res.json()) as { sms: { available: boolean } };
    expect(body.sms).toEqual({ available: true });
  });
});

describe("PATCH /api/portal/resident-notification-preferences", () => {
  it("preserves every other category's defaults on a first write for one category", async () => {
    const res = await patch({ preferences: { payments: { email: false } } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preferences: Record<string, { inbox: boolean; email: boolean; sms: boolean }> };

    expect(body.preferences.payments).toEqual({ inbox: true, email: false, sms: true });
    for (const category of Object.keys(DEFAULT_NOTIFICATION_PREFERENCES)) {
      if (category === "payments") continue;
      expect(body.preferences[category]).toEqual(
        DEFAULT_NOTIFICATION_PREFERENCES[category as keyof typeof DEFAULT_NOTIFICATION_PREFERENCES],
      );
    }
  });

  it("preserves a previously saved category when a later write touches a different one", async () => {
    const first = await patch({ preferences: { payments: { email: false, sms: false } } });
    expect(first.status).toBe(200);

    const second = await patch({ preferences: { messages: { sms: false } } });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { preferences: Record<string, { inbox: boolean; email: boolean; sms: boolean }> };

    // The payments write from the FIRST request must survive the SECOND
    // request, which never mentions payments at all.
    expect(body.preferences.payments).toEqual({ inbox: true, email: false, sms: false });
    expect(body.preferences.messages).toEqual({ inbox: true, email: true, sms: false });
  });

  it("clamps inbox on even when the payload tries to turn it off", async () => {
    const res = await patch({
      preferences: { maintenance: { inbox: false, email: false, sms: false } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preferences: Record<string, { inbox: boolean; email: boolean; sms: boolean }> };
    expect(body.preferences.maintenance.inbox).toBe(true);
    // The row actually persisted (not just the response) must also be clamped.
    expect((NOTIFICATION_PREFS[RESIDENT_ID] as Record<string, { inbox: boolean }>).maintenance.inbox).toBe(true);
  });

  it("never reads or writes a user id supplied by the caller, only the session's own", async () => {
    const res = await patch({
      userId: OTHER_ID,
      user_id: OTHER_ID,
      preferences: { messages: { email: false } },
    });
    expect(res.status).toBe(200);

    // Only the authenticated session's row was written.
    expect(Object.keys(NOTIFICATION_PREFS)).toEqual([RESIDENT_ID]);
    expect(NOTIFICATION_PREFS[OTHER_ID]).toBeUndefined();
    expect((NOTIFICATION_PREFS[RESIDENT_ID] as Record<string, { email: boolean }>).messages.email).toBe(false);
  });

  it("ignores a user id supplied via the query string too", async () => {
    const res = await patch(
      { preferences: { messages: { email: false } } },
      `http://localhost/api/portal/resident-notification-preferences?user_id=${OTHER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(Object.keys(NOTIFICATION_PREFS)).toEqual([RESIDENT_ID]);
    expect(NOTIFICATION_PREFS[OTHER_ID]).toBeUndefined();
  });

  it("refuses a caller holding no resident role", async () => {
    PROFILES[RESIDENT_ID] = { role: "manager" };
    PROFILE_ROLES[RESIDENT_ID] = ["manager"];
    const res = await patch({ preferences: { messages: { email: false } } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Residents only." });
    expect(NOTIFICATION_PREFS[RESIDENT_ID]).toBeUndefined();
  });

  it("answers 401 when unauthenticated and writes nothing", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await patch({ preferences: { messages: { email: false } } });
    expect(res.status).toBe(401);
    expect(NOTIFICATION_PREFS).toEqual({});
  });

  it("rejects a malformed preferences payload", async () => {
    const res = await patch({ preferences: "not-an-object" });
    expect(res.status).toBe(400);
  });
});
