import { describe, expect, it } from "vitest";
import { assertActor, assertDelivery, assertManifest, assertPhoneAvailability, assertProfile, assertPurchase, assertRoles, assertWorkspace, type GuardManifest } from "../helpers/signup-proof-guards";
const proofNow = Date.parse("2026-11-04T00:00:10Z");
const nonce = "a".repeat(32), actor = "11111111-1111-4111-8111-111111111111";
const manifest = (): GuardManifest & { actorId: string } => ({ email: `p8-manager-${nonce}-draft@example.invalid`, phone: "+12065550100", fullName: "P8 draft manager", tier: "pro", startedAt: "2026-11-04T00:00:00Z", actorId: actor });
const user = () => ({ id: actor, email: manifest().email, created_at: "2026-11-04T00:00:01Z", email_confirmed_at: "2026-11-04T00:00:02Z", phone_confirmed_at: null as string | null, app_metadata: { proplane_email_onboarding: true } });
const profile = () => ({ id: actor, email: manifest().email, full_name: manifest().fullName, phone: manifest().phone, phone_verified_at: null as string | null });
const purchase = () => ({ user_id: actor, email: manifest().email, manager_id: "manager-1", tier: "pro", billing: "trial", stripe_checkout_session_id: "axis_intent_synthetic", stripe_subscription_id: null as string | null });
describe("signup phone proof refusal guards", () => {
  it("accepts only the exact nonce, actor, mailbox, role and fictional number", () => {
    assertManifest(manifest(), nonce, proofNow); assertActor(manifest(), user()); assertProfile(manifest(), profile()); assertRoles(manifest(), [{ role: "manager" }]);
    for (const change of [{ email: "customer@example.com" }, { email: `p8-resident-${nonce}-resident@example.invalid` }, { phone: "+12065550200" }, { actorId: "foreign" }, { tier: "resident" as const }, { startedAt: "invalid" }]) expect(() => assertManifest({ ...manifest(), ...change }, nonce, proofNow)).toThrow();
    expect(() => assertManifest(manifest(), "b".repeat(32), proofNow)).toThrow();
    expect(() => assertManifest(manifest(), nonce, proofNow + 3_600_000)).toThrow();
    expect(() => assertManifest(manifest(), nonce, proofNow - 20_000)).toThrow();
    for (const change of [{ id: "foreign" }, { email: "foreign@example.invalid" }, { created_at: "2020-01-01" }, { created_at: "invalid" }, { email_confirmed_at: null }, { email_confirmed_at: "2020-01-01" }, { phone_confirmed_at: "2026-11-04" }, { app_metadata: {} }]) expect(() => assertActor(manifest(), { ...user(), ...change })).toThrow();
    for (const change of [{ id: "foreign" }, { email: "other@example.invalid" }, { full_name: "Other" }, { phone: "+12065550101" }, { phone_verified_at: "2026-11-04" }]) expect(() => assertProfile(manifest(), { ...profile(), ...change })).toThrow();
    for (const roles of [[], [{ role: "resident" }], [{ role: "manager" }, { role: "admin" }], [{ role: "manager" }, { role: "vendor" }]]) expect(() => assertRoles(manifest(), roles)).toThrow();
  });
  it("rejects foreign or paid purchases, workspaces and phone associations", () => {
    assertPurchase(manifest(), "manager-1", [purchase()], [{ id: actor }]);
    for (const change of [{ user_id: "foreign" }, { email: "other@example.invalid" }, { manager_id: "other" }, { tier: "business" }, { billing: "monthly" }, { stripe_checkout_session_id: "cs_real" }, { stripe_subscription_id: "sub_real" }]) expect(() => assertPurchase(manifest(), "manager-1", [{ ...purchase(), ...change }], [{ id: actor }])).toThrow();
    expect(() => assertPurchase(manifest(), "manager-1", [purchase()], [{ id: actor }, { id: "foreign" }])).toThrow();
    const resident = { ...manifest(), tier: "resident" as const, email: `p8-resident-${nonce}-resident@example.invalid` };
    assertManifest(resident, nonce, proofNow); assertRoles(resident, [{ role: "resident" }]); assertPurchase(resident, null, [], []);
    expect(() => assertPurchase(resident, null, [purchase()], [])).toThrow();
    const workspace = { owner_user_id: actor, created_at: "2026-11-04T00:00:03Z" };
    assertWorkspace(manifest(), [workspace], 0, 0, 0, 0);
    expect(() => assertWorkspace(manifest(), [{ ...workspace, owner_user_id: "foreign" }], 0, 0, 0, 0)).toThrow();
    expect(() => assertWorkspace(manifest(), [{ ...workspace, created_at: "2020-01-01" }], 0, 0, 0, 0)).toThrow();
    for (const args of [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] as const) expect(() => assertWorkspace(manifest(), [], ...args)).toThrow();
    assertPhoneAvailability(true, 0, 0, false, false);
    for (const args of [[false, 0, 0, false, false], [true, 1, 0, false, false], [true, 0, 1, false, false], [true, 0, 0, true, false], [true, 0, 0, false, true]] as const) expect(() => assertPhoneAvailability(...args)).toThrow();
  });
  it("rejects absent, foreign, mismatched or repeated delivery", () => {
    const context = { actorUserId: actor, managerUserId: actor };
    assertDelivery(actor, manifest().phone, actor, manifest().phone, context, 0);
    expect(() => assertDelivery(actor, manifest().phone, actor, manifest().phone, null, 0)).toThrow();
    expect(() => assertDelivery(actor, manifest().phone, "foreign", manifest().phone, context, 0)).toThrow();
    expect(() => assertDelivery(actor, manifest().phone, actor, "+12065550101", context, 0)).toThrow();
    expect(() => assertDelivery(actor, manifest().phone, actor, manifest().phone, { ...context, managerUserId: "foreign" }, 0)).toThrow();
    expect(() => assertDelivery(actor, manifest().phone, actor, manifest().phone, context, 1)).toThrow();
  });
});
