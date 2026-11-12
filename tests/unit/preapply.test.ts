import { describe, expect, it } from "vitest";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import { applicantIdCheckProvider } from "@/lib/resident-identity/provider";
import { defaultApplicantScreeningSettings, type ApplicantScreeningSettings } from "@/lib/screening/applicant-screening";
import { evaluatePreApply, preApplyOrderAllowed, resolvePreApplyPlan, type PreApplyEnvironment } from "@/lib/screening/preapply";

const checkrEnv: PreApplyEnvironment = { idEnabled: true, idProvider: "checkr", backgroundConfigured: true };
const personaEnv: PreApplyEnvironment = { idEnabled: true, idProvider: "persona", backgroundConfigured: true };
const settings = (over: Partial<ApplicantScreeningSettings> = {}): ApplicantScreeningSettings => ({
  idCheck: false,
  backgroundCheck: false,
  idUnlock: "clear",
  ...over,
});

function check(over: Partial<ApplicationBackgroundCheck> = {}): ApplicationBackgroundCheck {
  return {
    provider: "checkr",
    candidateId: "ap_1",
    reportId: "ord_1",
    packageSlug: "starter",
    status: "pending",
    result: null,
    orderedAt: "2026-11-12T00:00:00Z",
    ...over,
  };
}
const withId = (status: string, over: Partial<ApplicationBackgroundCheck> = {}) =>
  check({ addOnProducts: ["identity_verification"], reportSnapshot: { identity_verification: { status } }, ...over });

describe("pre-apply plan: the manager's choice", () => {
  it("requires nothing when neither is chosen (self-serve default)", () => {
    const plan = resolvePreApplyPlan({ settings: defaultApplicantScreeningSettings(false), env: checkrEnv });
    expect(plan.verifyId.required).toBe(false);
    expect(plan.backgroundCheck.required).toBe(false);
    expect(plan.order).toBeNull();
    const state = evaluatePreApply({ plan, check: null, personaVerified: false });
    expect(state).toMatchObject({ required: false, satisfied: true, next: "application", steps: [] });
  });

  it("requires both for a PropLane-managed workspace by default, as one Starter + ID order", () => {
    const plan = resolvePreApplyPlan({ settings: defaultApplicantScreeningSettings(true), env: checkrEnv });
    expect(plan.verifyId.required && plan.backgroundCheck.required).toBe(true);
    expect(plan.order?.includeIdCheck).toBe(true);
    expect(plan.order?.quote.totalCents).toBe(2794);
  });

  it("Verify ID alone still orders the cheapest orderable on Checkr (Starter + the ID add-on)", () => {
    const plan = resolvePreApplyPlan({ settings: settings({ idCheck: true }), env: checkrEnv });
    expect(plan.backgroundCheck.required).toBe(false);
    expect(plan.order).toMatchObject({ includeIdCheck: true });
    expect(plan.order?.quote.addOnProducts).toEqual(["identity_verification"]);
  });

  it("a background check alone is Starter with no ID add-on", () => {
    const plan = resolvePreApplyPlan({ settings: settings({ backgroundCheck: true }), env: checkrEnv });
    expect(plan.verifyId.required).toBe(false);
    expect(plan.order).toMatchObject({ includeIdCheck: false });
    expect(plan.order?.quote.totalCents).toBe(2499);
  });

  it("Persona: Verify ID is the standalone flow, so Verify ID alone needs no order at all", () => {
    const plan = resolvePreApplyPlan({ settings: settings({ idCheck: true }), env: personaEnv });
    expect(plan.verifyId).toMatchObject({ required: true, provider: "persona", unavailable: false });
    expect(plan.order).toBeNull();
  });

  it("Persona plus a background check orders Starter WITHOUT the ID add-on", () => {
    const plan = resolvePreApplyPlan({ settings: settings({ idCheck: true, backgroundCheck: true }), env: personaEnv });
    expect(plan.order).toMatchObject({ includeIdCheck: false });
    expect(plan.order?.quote.totalCents).toBe(2499);
  });

  it("master switch off: no ID requirement is enforced; misconfigured provider fails closed", () => {
    const off = resolvePreApplyPlan({ settings: settings({ idCheck: true }), env: { ...checkrEnv, idEnabled: false, idProvider: null } });
    expect(off.verifyId.required).toBe(false);
    const broken = resolvePreApplyPlan({ settings: settings({ idCheck: true }), env: { ...checkrEnv, idProvider: null } });
    expect(broken.verifyId).toMatchObject({ required: true, unavailable: true });
    const state = evaluatePreApply({ plan: broken, check: null, personaVerified: false });
    expect(state.satisfied).toBe(false);
    expect(state.steps[0]).toMatchObject({ id: "verify_id", status: "blocked", reason: "unavailable" });
  });

  it("an unconfigured Checkr is not a requirement the applicant could ever meet", () => {
    const plan = resolvePreApplyPlan({
      settings: settings({ backgroundCheck: true }),
      env: { ...checkrEnv, backgroundConfigured: false },
    });
    expect(plan.backgroundCheck.required).toBe(false);
    expect(plan.order).toBeNull();
  });
});

describe("provider resolution (Persona vs Checkr, never Stripe Identity)", () => {
  const persona = { PERSONA_API_KEY: "k", PERSONA_TEMPLATE_ID: "t", PERSONA_WEBHOOK_SECRET: "s" };
  it("defaults to Checkr when enabled and configured", () => {
    expect(applicantIdCheckProvider({ RESIDENT_IDENTITY_ENABLED: "true", CHECKR_API_KEY: "ck" })).toEqual({ enabled: true, provider: "checkr" });
  });
  it("uses Persona only with its provider switch AND all three keys", () => {
    expect(applicantIdCheckProvider({ RESIDENT_IDENTITY_ENABLED: "true", RESIDENT_IDENTITY_PROVIDER: "persona", ...persona }).provider).toBe("persona");
    expect(applicantIdCheckProvider({ RESIDENT_IDENTITY_ENABLED: "true", RESIDENT_IDENTITY_PROVIDER: "persona", PERSONA_API_KEY: "k" }).provider).toBeNull();
  });
  it("is off without the master switch and never resolves Stripe", () => {
    expect(applicantIdCheckProvider({ CHECKR_API_KEY: "ck" })).toEqual({ enabled: false, provider: null });
    expect(applicantIdCheckProvider({ RESIDENT_IDENTITY_ENABLED: "true", RESIDENT_IDENTITY_PROVIDER: "stripe", ...persona, CHECKR_API_KEY: "ck" }).provider).toBeNull();
  });
});

describe("pre-apply progress: Checkr", () => {
  const plan = resolvePreApplyPlan({ settings: settings({ idCheck: true, backgroundCheck: true }), env: checkrEnv });

  it("starts at Verify ID, then Background check, then Application; resume lands on the next step", () => {
    const start = evaluatePreApply({ plan, check: null, personaVerified: false });
    expect(start.steps.map((s) => s.id)).toEqual(["verify_id", "background_check"]);
    expect(start).toMatchObject({ satisfied: false, next: "verify_id" });
    expect(start.steps.every((s) => s.status === "todo")).toBe(true);
  });

  it("the form stays shut until the ID product returns clear (default unlock)", () => {
    const pending = evaluatePreApply({ plan, check: withId("clear", { status: "pending" }), personaVerified: false });
    expect(pending.satisfied).toBe(false);
    expect(pending.next).toBe("verify_id");
    expect(pending.steps[0]).toMatchObject({ status: "in_progress", satisfied: false });
    // The background step is the applicant's authorize-and-pay, already done.
    expect(pending.steps[1]).toMatchObject({ status: "in_progress", satisfied: true });
  });

  it("unlocks once the ID clears", () => {
    const done = evaluatePreApply({ plan, check: withId("clear", { status: "complete", result: "clear" }), personaVerified: false });
    expect(done).toMatchObject({ satisfied: true, next: "application" });
    expect(done.steps.map((s) => s.status)).toEqual(["done", "done"]);
  });

  it("'unlock after order' opens the form right after the order is placed", () => {
    const earlyPlan = resolvePreApplyPlan({ settings: settings({ idCheck: true, backgroundCheck: true, idUnlock: "order" }), env: checkrEnv });
    const state = evaluatePreApply({ plan: earlyPlan, check: withId("clear", { status: "pending" }), personaVerified: false });
    expect(state.satisfied).toBe(true);
  });

  it("an ID that did not clear needs review and keeps the form shut, even after the order", () => {
    for (const unlock of ["clear", "order"] as const) {
      const p = resolvePreApplyPlan({ settings: settings({ idCheck: true, idUnlock: unlock }), env: checkrEnv });
      const state = evaluatePreApply({ plan: p, check: withId("consider", { status: "complete", result: "consider" }), personaVerified: false });
      expect(state.satisfied).toBe(false);
      expect(state.steps[0]).toMatchObject({ status: "blocked", reason: "review" });
    }
  });

  it("an order without the ID add-on does not satisfy Verify ID, and a canceled order satisfies nothing", () => {
    expect(evaluatePreApply({ plan, check: check({ status: "complete", result: "clear" }), personaVerified: false }).steps[0]?.satisfied).toBe(false);
    expect(evaluatePreApply({ plan, check: withId("clear", { status: "canceled" }), personaVerified: false }).satisfied).toBe(false);
  });

  it("background check alone is satisfied as soon as the order is placed", () => {
    const bg = resolvePreApplyPlan({ settings: settings({ backgroundCheck: true }), env: checkrEnv });
    expect(evaluatePreApply({ plan: bg, check: check(), personaVerified: false }).satisfied).toBe(true);
    expect(evaluatePreApply({ plan: bg, check: null, personaVerified: false }).satisfied).toBe(false);
  });
});

describe("pre-apply progress: Persona", () => {
  it("Verify ID is satisfied by the account's approved Persona identity, not by any order", () => {
    const plan = resolvePreApplyPlan({ settings: settings({ idCheck: true }), env: personaEnv });
    expect(evaluatePreApply({ plan, check: null, personaVerified: false })).toMatchObject({ satisfied: false, next: "verify_id" });
    expect(evaluatePreApply({ plan, check: null, personaVerified: true })).toMatchObject({ satisfied: true, next: "application" });
  });

  it("with a background check too, the Persona step and the order are independent", () => {
    const plan = resolvePreApplyPlan({ settings: settings({ idCheck: true, backgroundCheck: true }), env: personaEnv });
    const half = evaluatePreApply({ plan, check: null, personaVerified: true });
    expect(half).toMatchObject({ satisfied: false, next: "background_check" });
    expect(evaluatePreApply({ plan, check: check(), personaVerified: true }).satisfied).toBe(true);
  });
});

describe("never a second charge", () => {
  const both = resolvePreApplyPlan({ settings: settings({ idCheck: true, backgroundCheck: true }), env: checkrEnv });
  it("allows an order only when none is live, or the ID is newly required and missing", () => {
    expect(preApplyOrderAllowed(both, null)).toBe(true);
    expect(preApplyOrderAllowed(both, withId("clear", { status: "canceled" }))).toBe(true);
    expect(preApplyOrderAllowed(both, withId("clear"))).toBe(false);
    expect(preApplyOrderAllowed(both, check())).toBe(true); // earlier Starter-only order, ID now required
    const bgOnly = resolvePreApplyPlan({ settings: settings({ backgroundCheck: true }), env: checkrEnv });
    expect(preApplyOrderAllowed(bgOnly, check())).toBe(false);
    expect(preApplyOrderAllowed(resolvePreApplyPlan({ settings: settings(), env: checkrEnv }), null)).toBe(false);
  });
});
