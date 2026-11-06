import { describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import { createMemoryDb } from "./support/memory-supabase";
import { hasVerifiedLegacyManagerEntitlement } from "@/lib/auth/legacy-manager-entitlement.server";

const id = "00000000-0000-4000-8000-0000000000aa";
const email = "manager@example.test";
const user = { id, email, email_confirmed_at: "confirmed" } as User;
function db(options: { authEmail?: string; profileEmail?: string; owner?: string | null; failAuth?: boolean; sessionId?: string } = {}) {
  const base = createMemoryDb({ profiles: [{ id, email: options.profileEmail ?? email }], manager_purchases: [{ id: "p1", email, user_id: options.owner ?? null, manager_id: "mgr", tier: "pro", billing: "monthly", paid_at: "2026-01-01", stripe_checkout_session_id: options.sessionId ?? "paid-session" }] });
  return Object.assign(base, { auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: { email: options.authEmail ?? email, email_confirmed_at: "confirmed" } }, error: options.failAuth ? { message: "unavailable" } : null }) } } });
}
describe("verified legacy manager entitlement", () => {
  it("reads a completed unclaimed purchase without changing ownership", async () => {
    const service = db();
    await expect(hasVerifiedLegacyManagerEntitlement(service as never, user)).resolves.toBe(true);
    expect(service.__tables.manager_purchases[0]?.user_id).toBeNull();
  });
  it("refuses an unconfirmed session", async () => {
    await expect(hasVerifiedLegacyManagerEntitlement(db() as never, { ...user, email_confirmed_at: undefined } as User)).resolves.toBe(false);
  });
  it.each([{ authEmail: "other@example.test" }, { owner: "00000000-0000-4000-8000-0000000000bb" }, { sessionId: "axis_pending_123" }])("does not use mismatched, other-owned, or pending rows", async (options) => {
    await expect(hasVerifiedLegacyManagerEntitlement(db(options) as never, user)).resolves.toBe(false);
  });
  it("does not depend on a stale mutable profile email", async () => {
    await expect(hasVerifiedLegacyManagerEntitlement(db({ profileEmail: "other@example.test" }) as never, user)).resolves.toBe(true);
  });
  it("fails closed when account verification cannot be read", async () => {
    await expect(hasVerifiedLegacyManagerEntitlement(db({ failAuth: true }) as never, user)).rejects.toThrow(/try again/i);
  });
});
