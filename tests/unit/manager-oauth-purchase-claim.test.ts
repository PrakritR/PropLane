import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/claw-onboarding-sms.server", () => ({ maybeSendManagerPropLaneAssistantIntro: vi.fn() }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ scheduleManagerMessagingReady: vi.fn() }));
import { completeManagerSignupFromOAuth } from "@/lib/auth/complete-manager-signup";
import { createMemoryDb } from "./support/memory-supabase";

const EMAIL = "manager@example.test";
function fixture(confirmed = true) {
  const db = createMemoryDb({ manager_purchases: [
    { id: "one", email: EMAIL, manager_id: "manager", user_id: null, full_name: "Name", stripe_checkout_session_id: "axis_intent_one" },
    { id: "other", email: EMAIL, manager_id: "other", user_id: null, stripe_checkout_session_id: "axis_intent_other" },
  ], profiles: [], profile_roles: [] });
  return Object.assign(db, { auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: { email: EMAIL, email_confirmed_at: confirmed ? "now" : null } }, error: null })) } } });
}
describe("exact manager OAuth purchase claim", () => {
  it("requires verified Auth email before any claim or role", async () => {
    const db = fixture(false);
    expect(await completeManagerSignupFromOAuth(db as never, "subject", EMAIL, "axis_intent_one")).toMatchObject({ ok: false, status: 403 });
    expect(db.__tables.manager_purchases![0]!.user_id).toBeNull();
    expect(db.__tables.profile_roles).toHaveLength(0);
  });
  it("claims for one subject, retains unrelated purchases, and allows same-subject retry", async () => {
    const db = fixture();
    expect(await completeManagerSignupFromOAuth(db as never, "first", EMAIL, "axis_intent_one")).toMatchObject({ ok: true });
    expect(await completeManagerSignupFromOAuth(db as never, "other", EMAIL, "axis_intent_one")).toMatchObject({ ok: false, status: 409 });
    expect(await completeManagerSignupFromOAuth(db as never, "first", EMAIL, "axis_intent_one")).toMatchObject({ ok: true });
    expect(db.__tables.manager_purchases).toHaveLength(2);
    expect(db.__tables.manager_purchases![1]!.user_id).toBeNull();
    expect(db.__tables.profile_roles!.some((row) => row.user_id === "other")).toBe(false);
  });
  it("grants only the winning subject in concurrent claims", async () => {
    const db = fixture();
    const results = await Promise.all(["first", "other"].map((id) => completeManagerSignupFromOAuth(db as never, id, EMAIL, "axis_intent_one")));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.status === 409)).toHaveLength(1);
    expect(db.__tables.profile_roles).toHaveLength(1);
    expect(db.__tables.profile_roles![0]!.user_id).toBe(db.__tables.manager_purchases![0]!.user_id);
  });
  it("finishes an interrupted claim owned by the same verified subject", async () => {
    const db = fixture();
    db.__tables.manager_purchases![0]!.user_id = "first";
    expect(await completeManagerSignupFromOAuth(db as never, "first", EMAIL, "axis_intent_one")).toMatchObject({ ok: true });
    expect(db.__tables.profile_roles).toMatchObject([{ user_id: "first", role: "manager" }]);
  });
  it("refuses a different verified mailbox", async () => {
    const db = fixture();
    expect(await completeManagerSignupFromOAuth(db as never, "first", "other@example.test", "axis_intent_one")).toMatchObject({ ok: false, status: 403 });
    expect(db.__tables.manager_purchases![0]!.user_id).toBeNull();
  });
});
