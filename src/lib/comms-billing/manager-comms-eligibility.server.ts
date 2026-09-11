import "server-only";

/**
 * ONE answer to "may this manager have a PropLane work contact channel?" —
 * shared by the work number and the work email.
 *
 * These two used to decide it separately and had drifted into contradicting
 * each other: the number honoured the pay-as-you-go billing gate (a card on
 * file qualifies a manager on ANY plan, Free included) and let a trial through
 * when trial onboarding was open, while the email ignored pay-as-you-go
 * entirely and demoted every trial to ineligible. With pay-as-you-go on, the
 * same manager could buy a work number and then be told they needed Pro for the
 * email — one product, two answers.
 *
 * The DECISION lives here so it can only ever be changed in one place. The
 * WORDING stays with each channel, because a refusal has to name the thing the
 * manager was actually asking for.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateManagerCommsBillingGate,
  type CommsBillingBlockReason,
  type CommsBillingGateResult,
} from "@/lib/comms-billing/eligibility.server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";
import type { SmsEntitlement } from "@/lib/sms/manager-sms-entitlement.server";
import { isTrialWorkNumberOnboardingEnabled } from "@/lib/sms/number-registration-policy";

/** Which work contact channel is being asked about. Only the copy differs. */
export type ManagerCommsChannel = "work_number" | "work_email";

export type ManagerCommsIneligible = Extract<SmsEntitlement, { eligible: false }>;

/**
 * Why a request may not proceed. `kind` says which authority refused, so each
 * channel can render its own message without re-deriving the decision.
 */
export type ManagerCommsRequestDecision =
  | { allowed: true }
  | { allowed: false; kind: "payg"; reason: CommsBillingBlockReason }
  | { allowed: false; kind: "entitlement"; entitlement: ManagerCommsIneligible };

/** The pay-as-you-go gate, or `null` when pay-as-you-go billing is switched off. */
export async function loadManagerCommsPaygGate(
  db: SupabaseClient,
  managerUserId: string,
): Promise<CommsBillingGateResult | null> {
  return isCommsPaygBillingEnabled()
    ? evaluateManagerCommsBillingGate(db, managerUserId)
    : null;
}

/**
 * An entitlement an authoritative billing re-read could still turn into a yes.
 *
 * A missing `sms_manager_entitlements` row reads back as `plan_unreadable`,
 * which is the state of every paid account before its first request — so a
 * stale snapshot must never be allowed to deadlock a genuinely paid manager.
 * `trialing` counts only while trial onboarding is open, because that is the
 * flag `reconcileTrialEntitlement` itself consults when it decides whether to
 * enrol the trial.
 */
export function managerCommsEntitlementCanBeReconciled(
  entitlement: SmsEntitlement,
): boolean {
  return (
    entitlement.eligible ||
    (entitlement.reason === "trialing" && isTrialWorkNumberOnboardingEnabled()) ||
    entitlement.reason === "plan_unreadable" ||
    entitlement.reason === "legacy_unknown"
  );
}

/**
 * Status-time: may the manager still be OFFERED the request?
 *
 * Optimistic on purpose — the authoritative reconciliation happens at the
 * request boundary, never on a status read.
 */
export function managerCommsRequestIsOfferable(input: {
  entitlement: SmsEntitlement;
  paygGate: CommsBillingGateResult | null;
}): boolean {
  if (input.paygGate) return input.paygGate.allowed;
  return managerCommsEntitlementCanBeReconciled(input.entitlement);
}

/**
 * Status-time: may the manager USE a channel they already have?
 *
 * Stricter than `managerCommsRequestIsOfferable`: an unreconciled snapshot is
 * grounds to keep offering the setup, never to start sending.
 */
export function managerCommsUseIsAllowed(input: {
  entitlement: SmsEntitlement;
  paygGate: CommsBillingGateResult | null;
}): boolean {
  return input.paygGate ? input.paygGate.allowed : input.entitlement.eligible;
}

/**
 * Request-time authority. `entitlement` must ALREADY be the reconciled one —
 * this never reconciles, so a caller cannot accidentally bill twice or read a
 * pre-reconcile snapshot.
 *
 * Under pay-as-you-go the channel is BOUGHT rather than bundled, so the card is
 * the requirement and the plan entitlement is not consulted at all. With
 * pay-as-you-go off, the plan entitlement stands in, which means turning the
 * flag off restores the old rule rather than leaving the channel ungated.
 */
export async function decideManagerCommsRequest(
  db: SupabaseClient,
  managerUserId: string,
  entitlement: SmsEntitlement,
): Promise<ManagerCommsRequestDecision> {
  if (isCommsPaygBillingEnabled()) {
    const gate = await evaluateManagerCommsBillingGate(db, managerUserId);
    return gate.allowed ? { allowed: true } : { allowed: false, kind: "payg", reason: gate.reason };
  }
  if (entitlement.eligible) return { allowed: true };
  return { allowed: false, kind: "entitlement", entitlement };
}

/**
 * An entitlement refusal we could not settle rather than one we did: HTTP 503
 * and "try again", not 403 and "upgrade". Telling a paid manager to buy a plan
 * they already have because our own billing read failed is the worse mistake.
 */
export function managerCommsEntitlementIsUnreadable(
  entitlement: ManagerCommsIneligible,
): boolean {
  return entitlement.reason === "plan_unreadable" || entitlement.reason === "legacy_unknown";
}
