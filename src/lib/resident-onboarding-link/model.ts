/**
 * Text onboarding link, pure half. A manager (or the assistant, on an approved application or a confirmed booking)
 * texts ONE link; the resident opens it, proves the phone with a one-time code, and finishes in one or two screens.
 *
 * The link is the existing phone-bound link service (`phone_bound_links`, purpose `move_in`, `requires_otp`): a random
 * token of which only the SHA-256 is stored, bound to the phone on the record, single use, 14 days. It names a RECORD
 * (`application:<id>` / `booking:<id>`), never a URL or a person, and nothing about the record is read before the code
 * is proven. No account exists until then.
 */
import { toGsm7 } from "@/lib/one-number/segments";

/** `phone_bound_links.target_type` of an onboarding link (the resident-portal `move_in` links use `resident`). */
export const ONBOARDING_TARGET_TYPE = "onboarding";

export type OnboardingSourceKind = "application" | "booking";

export function onboardingTargetId(kind: OnboardingSourceKind, id: string): string {
  return `${kind}:${id.trim()}`;
}

export function parseOnboardingTargetId(value: string): { kind: OnboardingSourceKind; id: string } | null {
  const match = /^(application|booking):([A-Za-z0-9_.:-]{1,160})$/.exec(String(value ?? "").trim());
  return match ? { kind: match[1] as OnboardingSourceKind, id: match[2]! } : null;
}

/** What PropLane already knows, drawn as the form's starting values. Never includes the full phone. */
export type OnboardingPrefill = {
  fullName: string;
  email: string;
  houseLabel: string;
  roomLabel: string;
  moveInDate: string;
  /** The house rules the resident accepts; empty when the house has none on file. */
  houseRules: string;
  /** The last four digits of the phone the code went to. */
  maskedPhone: string;
  /** The manager requires Verify ID for this house and the resident has not passed it. */
  verifyIdRequired: boolean;
};

export type OnboardingInput = {
  fullName: string;
  /** Optional, and only ever a claim: it is never the login. */
  email: string;
  acceptRules: boolean;
  /** "Add me to my house group text". Default yes; a no is the same state as texting LEAVE GROUP. */
  joinGroupText: boolean;
};

export type OnboardingInputResult = { ok: true; value: OnboardingInput } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function validateOnboardingInput(raw: unknown, opts: { rulesRequired: boolean }): OnboardingInputResult {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fullName = typeof r.fullName === "string" ? r.fullName.replace(/\s+/g, " ").trim() : "";
  if (fullName.length < 2 || fullName.length > 80) return { ok: false, error: "Enter your full name." };
  const email = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) return { ok: false, error: "That email does not look right." };
  if (opts.rulesRequired && r.acceptRules !== true) return { ok: false, error: "Accept the house rules to continue." };
  return { ok: true, value: { fullName, email, acceptRules: r.acceptRules === true, joinGroupText: r.joinGroupText !== false } };
}

/** The ONE text. A first name, the house, one link; STOP wording rides with it. Plain GSM-7. */
export function onboardingLinkText(input: { firstName: string; houseLabel: string; url: string }): string {
  const name = input.firstName.trim();
  const house = input.houseLabel.trim();
  const lead = name ? `Hi ${name}, ` : "Hi, ";
  const where = house ? ` at ${house}` : "";
  return toGsm7(`${lead}welcome${where}. Finish setting up your PropLane account in about a minute:\n${input.url}\nReply STOP to opt out.`);
}

/** The welcome text after the account exists. */
export function onboardingWelcomeText(input: { firstName: string; houseLabel: string }): string {
  const name = input.firstName.trim();
  const house = input.houseLabel.trim();
  return toGsm7(`Welcome${name ? `, ${name}` : ""}${house ? ` to ${house}` : ""}! You're all set. You can sign in with this phone any time. Reply STOP to opt out.`);
}

export function firstNameOf(fullName: string): string {
  return (String(fullName ?? "").trim().split(/\s+/)[0] ?? "").replace(/[^\p{L}'-]/gu, "").slice(0, 40);
}
