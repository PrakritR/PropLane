import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveChannels } from "@/lib/notification-preferences";

/**
 * Minimal chainable Supabase mock, matching the convention in
 * notification-preferences.test.ts: every `.from(table).select().eq().maybeSingle()`
 * resolves to the row configured for that table. `resolveChannels` (resident/
 * vendor branch) touches `notification_preferences` (saved prefs), `sms_consent`
 * (opt-out), and `profiles` (phone fallback when no recipientProfile is passed).
 *
 * Pass a function for a table's row to simulate a throwing read (used for the
 * fail-open test) instead of a plain value.
 */
function mockDb(rows: {
  notification_preferences?: unknown | (() => unknown);
  sms_consent?: unknown;
  profiles?: unknown;
}): SupabaseClient {
  const chain = (tableRow: unknown) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.maybeSingle = async () => {
      if (typeof tableRow === "function") return tableRow();
      return { data: tableRow };
    };
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
const MANAGER_PROFILE = { phone: "5551234567", phone_verified_at: null, role: "manager" };

vi.mock("@/lib/manager-notification-routing.server", () => ({
  resolveManagerNotificationChannels: vi.fn(async () => ({
    inbox: false,
    email: false,
    sms: false,
    _managerBranch: true,
  })),
}));

describe("resolveChannels — resident/vendor branch now consults saved preferences", () => {
  it("an unset resident (no row) is byte-identical to today: inbox+email on, sms as before", async () => {
    const db = mockDb({});
    const ch = await resolveChannels(db, "u1", "payments", WITH_PHONE);
    expect(ch).toEqual({ inbox: true, email: true, sms: true });
  });

  it("an unset resident with no phone still gets inbox+email, never sms", async () => {
    const db = mockDb({});
    const ch = await resolveChannels(db, "u1", "messages", NO_PHONE);
    expect(ch).toEqual({ inbox: true, email: true, sms: false });
  });

  it("a saved email:false applies only to that category, not others", async () => {
    const db = mockDb({
      notification_preferences: { row_data: { payments: { email: false } } },
    });
    const paymentsCh = await resolveChannels(db, "u1", "payments", WITH_PHONE);
    expect(paymentsCh.email).toBe(false);

    const leasesCh = await resolveChannels(db, "u1", "leases", WITH_PHONE);
    expect(leasesCh.email).toBe(true);
  });

  it("a saved sms:true is still false when the phone is opted out — consent beats preference", async () => {
    const db = mockDb({
      notification_preferences: { row_data: { payments: { sms: true } } },
      sms_consent: { opted_out_at: "2026-02-01T00:00:00Z", opted_in_at: null },
    });
    const ch = await resolveChannels(db, "u1", "payments", WITH_PHONE);
    expect(ch.sms).toBe(false);
  });

  it("a saved sms:false suppresses sms even when the phone is not opted out", async () => {
    const db = mockDb({
      notification_preferences: { row_data: { payments: { sms: false } } },
    });
    const ch = await resolveChannels(db, "u1", "payments", WITH_PHONE);
    expect(ch.sms).toBe(false);
  });

  it("a saved inbox:false is ignored — inbox is still true (non-suppressible)", async () => {
    const db = mockDb({
      notification_preferences: { row_data: { messages: { inbox: false, email: false } } },
    });
    const ch = await resolveChannels(db, "u1", "messages", WITH_PHONE);
    expect(ch.inbox).toBe(true);
    // email:false in the same saved row still applies — inbox alone is pinned.
    expect(ch.email).toBe(false);
  });

  it("a preference-table read error fails OPEN to email:true and does not throw", async () => {
    const db = mockDb({
      notification_preferences: () => {
        throw new Error("connection reset");
      },
    });
    await expect(resolveChannels(db, "u1", "payments", WITH_PHONE)).resolves.toEqual({
      inbox: true,
      email: true,
      sms: true,
    });
  });

  it("the manager branch is untouched — still delegates to resolveManagerNotificationChannels", async () => {
    const db = mockDb({});
    const ch = await resolveChannels(db, "m1", "payments", MANAGER_PROFILE);
    expect(ch).toEqual({ inbox: false, email: false, sms: false, _managerBranch: true });
  });
});
