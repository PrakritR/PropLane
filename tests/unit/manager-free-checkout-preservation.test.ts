import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
import { finalizePendingManagerFreeTier } from "@/lib/auth/manager-onboarding";
import { resolveManagerCheckoutPurchase } from "@/lib/manager-purchase-from-session";
import { createMemoryDb } from "./support/memory-supabase";

const opts = { userId: "user", email: "manager@example.test", tier: "free" as const, billing: "free" as const };
const row = { id: "purchase", user_id: "user", email: opts.email, manager_id: "manager", tier: null, billing: null, paid_at: null, stripe_checkout_session_id: "cs_test_live_reservation" };
it("keeps a live Stripe reservation intact for the later paid webhook", async () => {
  const db = createMemoryDb({ auth_users: [{ id: "user", email: opts.email, email_confirmed_at: "now" }], manager_purchases: [row] });
  // Refused, but as a RESULT, not a throw: the caller may already have written half a provisioning.
  await expect(finalizePendingManagerFreeTier(db as never, opts)).resolves.toEqual({ status: "skipped", reason: "checkout_in_progress" });
  expect(db.__tables.manager_purchases![0]!.stripe_checkout_session_id).toBe("cs_test_live_reservation");
  await expect(resolveManagerCheckoutPurchase(db as never, { id: "cs_test_live_reservation", customer_email: opts.email, metadata: { userId: "user", manager_id: "manager" } } as never)).resolves.toMatchObject({ id: "purchase", userId: "user" });
});
it("refuses a free finalize when checkout reserves the same row after the read", async () => {
  const db = createMemoryDb({ auth_users: [{ id: "user", email: opts.email, email_confirmed_at: "now" }], manager_purchases: [{ ...row, stripe_checkout_session_id: "axis_pending_original" }] });
  const from = db.from;
  const interleaved = { ...db, from: (table: string) => {
    const builder = from(table);
    if (table !== "manager_purchases") return builder;
    const maybeSingle = builder.maybeSingle.bind(builder);
    builder.maybeSingle = async () => {
      const result = await maybeSingle();
      return { ...result, data: result.data ? structuredClone(result.data) : null };
    };
    const update = builder.update.bind(builder);
    builder.update = (...args: Parameters<typeof builder.update>) => {
      db.__tables.manager_purchases![0]!.stripe_checkout_session_id = "cs_test_live_reservation";
      return update(...args);
    };
    return builder;
  } };
  await expect(finalizePendingManagerFreeTier(interleaved as never, opts)).rejects.toThrow(/signup changed/i);
  expect(db.__tables.manager_purchases![0]!.stripe_checkout_session_id).toBe("cs_test_live_reservation");
});
