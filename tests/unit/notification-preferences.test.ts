import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  normalizeNotificationPreferences,
  resolveChannels,
} from "@/lib/notification-preferences";

/**
 * Minimal chainable Supabase mock: every `.from(table).select().eq().maybeSingle()`
 * resolves to the row configured for that table. resolveChannels touches
 * `sms_consent` (opt-out) and `profiles` (phone fallback).
 */
function mockDb(rows: {
  notification_preferences?: unknown;
  sms_consent?: unknown;
  profiles?: unknown;
}): SupabaseClient {
  const chain = (data: unknown) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.maybeSingle = async () => ({ data });
    return c;
  };
  return {
    from(table: string) {
      return chain((rows as Record<string, unknown>)[table] ?? null);
    },
  } as unknown as SupabaseClient;
}

const WITH_PHONE = { phone: "5551234567", phone_verified_at: null };
const NO_PHONE = { phone: "", phone_verified_at: null };

/**
 * DELIBERATE REVERSAL — read before changing these two tests back.
 *
 * This block used to be titled "always-on delivery (not user-tunable)" and
 * asserted that a saved `email: false` was IGNORED. That was a real product
 * decision, deliberately locked in by a test.
 *
 * It has been reversed on purpose: residents now have a notification
 * preferences page, and a control that saves a setting delivery then ignores
 * is exactly the class of lying control this work exists to remove. Email and
 * SMS now follow the saved preference.
 *
 * What has NOT changed, and must not:
 *   - `inbox` is still always true. It is the durable record.
 *   - a STOP opt-out still beats a saved `sms: true`. Consent is not a
 *     preference (see the opt-out tests below, which are untouched).
 *   - an absent row still means "receive everything", so no existing resident's
 *     delivery changed: `notification_preferences` had zero writers before the
 *     preferences page shipped, so in practice every row is absent.
 */
describe("resolveChannels — delivery follows the resident's saved preferences", () => {
  it("inbox + email + SMS are all on for every category when a phone is on file and nothing is saved", async () => {
    const db = mockDb({});
    for (const category of NOTIFICATION_CATEGORIES) {
      const ch = await resolveChannels(db, "u1", category, WITH_PHONE);
      expect(ch.inbox).toBe(true);
      expect(ch.email).toBe(true);
      expect(ch.sms).toBe(true);
    }
  });

  it("a saved 'off' preference is honoured for that category, and only that category", async () => {
    const db = mockDb({
      notification_preferences: { row_data: { payments: { email: false, sms: false } } },
    });
    const ch = await resolveChannels(db, "u1", "payments", WITH_PHONE);
    expect(ch.email).toBe(false);
    expect(ch.sms).toBe(false);
    // The durable record is never suppressible, whatever the row says.
    expect(ch.inbox).toBe(true);
    // An untouched category keeps the default.
    const other = await resolveChannels(db, "u1", "messages", WITH_PHONE);
    expect(other.email).toBe(true);
  });

  it("no phone on the profile → no SMS (email + inbox still deliver)", async () => {
    const db = mockDb({});
    const ch = await resolveChannels(db, "u1", "messages", NO_PHONE);
    expect(ch.sms).toBe(false);
    expect(ch.email).toBe(true);
    expect(ch.inbox).toBe(true);
  });

  it("an unverified phone still receives SMS (signup-collected numbers text automatically)", async () => {
    const db = mockDb({});
    const ch = await resolveChannels(db, "u1", "payments", WITH_PHONE);
    expect(ch.sms).toBe(true);
  });

  it("a STOP opt-out is a hard gate — no SMS for any category", async () => {
    const db = mockDb({
      sms_consent: { opted_out_at: "2026-02-01T00:00:00Z", opted_in_at: null },
    });
    for (const category of NOTIFICATION_CATEGORIES) {
      const ch = await resolveChannels(db, "u1", category, WITH_PHONE);
      expect(ch.sms).toBe(false);
    }
  });

  it("falls back to the profiles table when no recipient profile is passed", async () => {
    const db = mockDb({ profiles: { phone: "5551234567", phone_verified_at: null } });
    const ch = await resolveChannels(db, "u1", "leases");
    expect(ch.sms).toBe(true);
  });
});

describe("DEFAULT_NOTIFICATION_PREFERENCES + normalize", () => {
  it("every category defaults inbox + email + sms on", () => {
    for (const ch of Object.values(DEFAULT_NOTIFICATION_PREFERENCES)) {
      expect(ch.inbox).toBe(true);
      expect(ch.email).toBe(true);
      expect(ch.sms).toBe(true);
    }
  });

  it("normalize forces inbox on and clamps to the known categories", () => {
    const out = normalizeNotificationPreferences({ messages: { inbox: false, sms: true }, bogus: {} });
    expect(out.messages.inbox).toBe(true); // inbox not user-suppressible
    expect(out.messages.sms).toBe(true);
    expect(Object.keys(out).sort()).toEqual(
      ["account", "applications", "leases", "maintenance", "messages", "payments", "voice_calls"].sort(),
    );
  });
});
