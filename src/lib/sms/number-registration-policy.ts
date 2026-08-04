import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { isManagerPurchasePeriodExpired } from "@/lib/manager-tier-expiry";
import { MANAGER_SUBSCRIPTION_TRIAL_DAYS } from "@/lib/stripe/subscription-checkout-session";

/**
 * Pure policy for the per-manager SMS number system. No Twilio / Supabase
 * imports so it is cheap to unit-test and safe to import from anywhere.
 *
 * Two independent axes decide whether a manager can send from their OWN number:
 *   1. provision_state — does a usable number physically exist yet?
 *   2. registration_state — is that manager's messaging registration approved?
 *
 * The ISV/reseller model makes registration PER MANAGER. A single shared
 * registration is just the degenerate case where every manager's row points at
 * one shared record (`registration_ref`) whose state is resolved from env, so
 * one flip approves everyone through the exact same code path.
 */

export type ProvisionState =
  | "pending_registration"
  | "provisioning"
  | "active"
  | "failed"
  | "released";

export type RegistrationState = "pending" | "approved" | "rejected";

export type ManagerSmsNumberRecord = {
  managerUserId: string;
  phoneNumber: string | null;
  phoneNumberSid: string | null;
  messagingServiceSid: string | null;
  provider: string;
  areaCode: string | null;
  provisionState: ProvisionState;
  registrationState: RegistrationState;
  registrationRef: string | null;
  attempts: number;
  lastError: string | null;
  requestedAt: string | null;
  provisionedAt: string | null;
  releasedAt: string | null;
  registrationUpdatedAt: string | null;
  updatedAt: string | null;
  /** When service was first suspended for a unpaid/downgraded account. */
  serviceSuspendedAt: string | null;
  /** When the pre-release warning email was sent (null until warned). */
  suspensionWarnedAt: string | null;
};

/** Days a suspended number is kept before Twilio release (captain: 90-day grace). */
export const SMS_NUMBER_SUSPENSION_GRACE_DAYS = 90;
/** Warn this many days before release (grace − warn = first warning day). */
export const SMS_NUMBER_SUSPENSION_WARN_DAYS_BEFORE = 7;

const PROVISION_STATES: ReadonlySet<string> = new Set([
  "pending_registration",
  "provisioning",
  "active",
  "failed",
  "released",
]);

const REGISTRATION_STATES: ReadonlySet<string> = new Set(["pending", "approved", "rejected"]);

export function normalizeProvisionState(value: string | null | undefined): ProvisionState {
  const v = String(value ?? "").trim();
  return (PROVISION_STATES.has(v) ? v : "pending_registration") as ProvisionState;
}

export function normalizeRegistrationState(value: string | null | undefined): RegistrationState {
  const v = String(value ?? "").trim();
  return (REGISTRATION_STATES.has(v) ? v : "pending") as RegistrationState;
}

/**
 * Registration state a deployment applies to managers who share ONE registration
 * record (env `SMS_SHARED_REGISTRATION_STATE`, default `pending`). This is what
 * lets a single-brand deployment flip everyone live by changing one env var
 * without touching per-manager rows.
 */
export function sharedRegistrationState(
  env: Record<string, string | undefined> = process.env,
): RegistrationState {
  return normalizeRegistrationState(env.SMS_SHARED_REGISTRATION_STATE);
}

/** The shared-registration ref this deployment recognises (default `shared`). */
export function sharedRegistrationRef(
  env: Record<string, string | undefined> = process.env,
): string {
  return String(env.SMS_SHARED_REGISTRATION_REF ?? "shared").trim() || "shared";
}

/**
 * Effective registration state for a manager. When the row points at the shared
 * registration record, the state comes from env (so one flip moves everyone);
 * otherwise the manager's own per-row state is authoritative. One code path
 * covers both the reseller (per-manager) and single-shared-registration models.
 */
export function effectiveRegistrationState(
  record: Pick<ManagerSmsNumberRecord, "registrationState" | "registrationRef">,
  env: Record<string, string | undefined> = process.env,
): RegistrationState {
  const ref = String(record.registrationRef ?? "").trim();
  if (ref && ref === sharedRegistrationRef(env)) {
    return sharedRegistrationState(env);
  }
  return normalizeRegistrationState(record.registrationState);
}

/**
 * Money guard: real Twilio purchases only happen when explicitly enabled
 * (`SMS_PROVISIONING_ENABLED=1`). Off by default so a fleet of managers can be
 * parked in `pending_registration` with zero spend until an operator opts in.
 * Independent of registration: a number may be bought before it can send.
 */
export function isProvisioningEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return String(env.SMS_PROVISIONING_ENABLED ?? "").trim() === "1";
}

/**
 * True when the manager may send from their own provisioned number: a usable
 * number physically exists AND that manager's registration is approved. A number
 * can be `active` while registration is still `pending` — it exists but cannot
 * send yet, which is exactly the state a freshly provisioned reseller number
 * sits in until its brand clears.
 */
export function managerCanSendFromOwnNumber(
  record: Pick<
    ManagerSmsNumberRecord,
    "provisionState" | "phoneNumber" | "registrationState" | "registrationRef"
  > | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!record) return false;
  if (normalizeProvisionState(record.provisionState) !== "active") return false;
  if (!String(record.phoneNumber ?? "").trim()) return false;
  return effectiveRegistrationState(record, env) === "approved";
}

/** True when a number physically exists (active) regardless of registration. */
export function managerHasActiveNumber(
  record: Pick<ManagerSmsNumberRecord, "provisionState" | "phoneNumber"> | null,
): boolean {
  if (!record) return false;
  return (
    normalizeProvisionState(record.provisionState) === "active" &&
    !!String(record.phoneNumber ?? "").trim()
  );
}

/** States a provisioning sweep should (re)attempt when provisioning is enabled. */
export function needsProvisioning(
  record: Pick<ManagerSmsNumberRecord, "provisionState"> | null,
): boolean {
  if (!record) return true;
  const state = normalizeProvisionState(record.provisionState);
  return state === "pending_registration" || state === "failed";
}

// ---------------------------------------------------------------------------
// Quiet hours — applies to non-urgent AUTOMATED sends (rent reminders, notices),
// never to STOP/HELP control replies or a manager's own live reply.
// ---------------------------------------------------------------------------

export type QuietHoursConfig = {
  /** IANA timezone the window is evaluated in. */
  tz: string;
  /** Inclusive hour [0-23] quiet hours begin (e.g. 21 = 9pm). */
  startHour: number;
  /** Exclusive hour [0-23] quiet hours end (e.g. 8 = 8am). */
  endHour: number;
};

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  tz: "America/Los_Angeles",
  startHour: 21,
  endHour: 8,
};

/** Hour-of-day [0-23] for `date` in the given IANA timezone. */
export function hourInTimezone(date: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    }).formatToParts(date);
    const raw = parts.find((p) => p.type === "hour")?.value ?? "0";
    // Intl can emit "24" for midnight under hour12:false — fold to 0.
    const h = Number(raw) % 24;
    return Number.isFinite(h) ? h : 0;
  } catch {
    return date.getUTCHours();
  }
}

/**
 * True when `date` falls inside quiet hours. Handles windows that wrap past
 * midnight (start > end), which is the common 9pm–8am case.
 */
export function isWithinQuietHours(
  date: Date,
  config: QuietHoursConfig = DEFAULT_QUIET_HOURS,
): boolean {
  const hour = hourInTimezone(date, config.tz);
  const { startHour, endHour } = config;
  if (startHour === endHour) return false; // no quiet window
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // Wraps midnight: quiet if at/after start OR before end.
  return hour >= startHour || hour < endHour;
}

// ---------------------------------------------------------------------------
// Paid entitlement + deliberate enablement.
//
// A work number is a PAID feature: only an ACTIVELY PAID Pro or Business
// subscription earns one. The 14-day free trial is not payment — a trialing
// manager gets no number. On downgrade to Free the number is NEVER
// auto-released (people hand the number out); service is suspended by the
// same access decision at send time, and the retention question is a human
// call.
//
// Rollout is DELIBERATE, not blanket: `SMS_PROVISIONING_ALLOWLIST` names the
// accounts enabled today (emails or user ids, comma-separated). Unset/empty →
// CLOSED, nobody provisions. `*` → every actively-paid Pro/Business account
// (the eventual steady state). A listed account is enabled by the captain's
// own decision and bypasses the billing check — that is the per-account pilot
// lever (currently exactly one production account).
// ---------------------------------------------------------------------------

export type ManagerNumberPlanInput = {
  tier: string | null;
  billing: string | null;
  paidAt: string | null;
  stripeSubscriptionId: string | null;
  readFailed: boolean;
};

export type ManagerNumberAccessReason =
  | "allowlisted"
  | "paid"
  | "not_enabled"
  | "plan_unreadable"
  | "not_paid_tier"
  | "trialing"
  | "expired";

export type ManagerNumberAccessDecision = {
  allowed: boolean;
  via: "allowlist" | "paid" | null;
  reason: ManagerNumberAccessReason;
};

/**
 * "Actively paid, not trialing": tier is Pro/Business AND the purchase is past
 * any trial AND not date-expired. Stripe-backed rows use paid_at + the trial
 * length (Stripe collects at trial end; a canceled/failed subscription is
 * downgraded by tier-sync, so a surviving paid tier past the window is an
 * active payer). A Stripe row with no paid_at cannot prove its trial is over
 * and fails closed as trialing.
 */
export function managerNumberPaidEntitlement(
  plan: ManagerNumberPlanInput,
  nowMs = Date.now(),
): { entitled: boolean; reason: ManagerNumberAccessReason } {
  if (plan.readFailed) return { entitled: false, reason: "plan_unreadable" };
  const tier = normalizeManagerSkuTier(plan.tier);
  if (tier !== "pro" && tier !== "business") return { entitled: false, reason: "not_paid_tier" };
  const billing = plan.billing?.toLowerCase().trim() ?? "";
  if (billing === "trial") return { entitled: false, reason: "trialing" };
  if (plan.stripeSubscriptionId?.trim()) {
    const paidAtMs = plan.paidAt ? new Date(plan.paidAt).getTime() : Number.NaN;
    if (!Number.isFinite(paidAtMs)) return { entitled: false, reason: "trialing" };
    const trialEndMs = paidAtMs + MANAGER_SUBSCRIPTION_TRIAL_DAYS * 24 * 60 * 60 * 1000;
    if (nowMs < trialEndMs) return { entitled: false, reason: "trialing" };
    return { entitled: true, reason: "paid" };
  }
  if (
    isManagerPurchasePeriodExpired(
      {
        tier: plan.tier,
        billing: plan.billing,
        paid_at: plan.paidAt,
        stripe_subscription_id: plan.stripeSubscriptionId,
      },
      nowMs,
    )
  ) {
    return { entitled: false, reason: "expired" };
  }
  return { entitled: true, reason: "paid" };
}

export type SmsProvisioningAllowlist =
  | { mode: "closed" }
  | { mode: "all_paid" }
  | { mode: "list"; entries: ReadonlySet<string> };

/** `SMS_PROVISIONING_ALLOWLIST`: unset → closed; `*` → all paid; else entries. */
export function smsProvisioningAllowlist(
  env: Record<string, string | undefined> = process.env,
): SmsProvisioningAllowlist {
  const raw = String(env.SMS_PROVISIONING_ALLOWLIST ?? "").trim();
  if (!raw) return { mode: "closed" };
  if (raw === "*") return { mode: "all_paid" };
  return {
    mode: "list",
    entries: new Set(
      raw
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}

/**
 * The ONE access decision for a manager's per-number service: may this account
 * hold/use a work number right now? Read by BOTH the purchase path (buying)
 * and the send path (a downgraded manager's number suspends service without
 * being released). Callers on the SEND path should treat `plan_unreadable` as
 * allowed (an infra blip must not drop messaging); the PURCHASE path fails
 * closed on it (money).
 */
export function managerNumberAccessDecision(args: {
  plan: ManagerNumberPlanInput;
  email: string | null;
  userId: string;
  env?: Record<string, string | undefined>;
  nowMs?: number;
}): ManagerNumberAccessDecision {
  const allowlist = smsProvisioningAllowlist(args.env);
  if (allowlist.mode === "closed") return { allowed: false, via: null, reason: "not_enabled" };
  if (allowlist.mode === "list") {
    const email = args.email?.trim().toLowerCase() ?? "";
    const id = args.userId.trim().toLowerCase();
    if ((email && allowlist.entries.has(email)) || (id && allowlist.entries.has(id))) {
      return { allowed: true, via: "allowlist", reason: "allowlisted" };
    }
    return { allowed: false, via: null, reason: "not_enabled" };
  }
  const paid = managerNumberPaidEntitlement(args.plan, args.nowMs);
  return paid.entitled
    ? { allowed: true, via: "paid", reason: "paid" }
    : { allowed: false, via: null, reason: paid.reason };
}

export type SmsSendClass = "control" | "transactional" | "automated";

/**
 * Whether a send of the given class is allowed to go out right now. Quiet hours
 * only suppress `automated` traffic (rent reminders, bulk notices). Control
 * (STOP/HELP) and transactional (a manager's live reply, an AI answer to an
 * inbound question) are always allowed.
 */
export function quietHoursBlocks(
  sendClass: SmsSendClass,
  date: Date,
  config: QuietHoursConfig = DEFAULT_QUIET_HOURS,
): boolean {
  if (sendClass !== "automated") return false;
  return isWithinQuietHours(date, config);
}
