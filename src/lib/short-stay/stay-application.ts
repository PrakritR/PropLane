/**
 * The answers on a short-stay booking APPLICATION (the resident portal's `/resident/stays/request`):
 * why they are staying, a note to the host, who else is staying and the house-rules agreement. Saved on
 * `stayDetails.application` of the hold and drawn to the manager on the hold in Bookings. Pure: the
 * request page, the route, the manager sheet and the tests all read the same rules.
 */
import { SHORT_STAY_MAX_GUESTS } from "@/lib/short-stay-request";

export const STAY_PURPOSES = [
  { value: "travel", label: "Travel or vacation" },
  { value: "work", label: "Work or business" },
  { value: "relocating", label: "Moving, between homes" },
  { value: "family", label: "Visiting family or friends" },
  { value: "medical", label: "Medical stay" },
  { value: "other", label: "Something else" },
] as const;

export type StayPurpose = (typeof STAY_PURPOSES)[number]["value"];

export const STAY_MESSAGE_MAX = 1000;
export const STAY_GUEST_NAME_MAX = 120;

export type StayApplicationAnswers = {
  purpose: StayPurpose;
  /** A note to the host. May be empty. */
  message: string;
  /** The OTHER guests, by name; the account holder is the session and is never listed here. */
  guestNames: string[];
  /** ISO instant the guest agreed to the house rules (the server stamps it). */
  rulesAgreedAt: string;
};

export function stayPurposeLabel(value: string): string {
  return STAY_PURPOSES.find((purpose) => purpose.value === value)?.label ?? "Something else";
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Reads a STORED application back; null when there is none (a manager-typed or older stay). */
export function normalizeStayApplication(raw: unknown): StayApplicationAnswers | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const purpose = STAY_PURPOSES.find((candidate) => candidate.value === value.purpose)?.value;
  if (!purpose) return null;
  const names = Array.isArray(value.guestNames) ? value.guestNames.map((name) => clean(name, STAY_GUEST_NAME_MAX)).filter(Boolean) : [];
  return {
    purpose,
    message: typeof value.message === "string" ? value.message.trim().slice(0, STAY_MESSAGE_MAX) : "",
    guestNames: names.slice(0, SHORT_STAY_MAX_GUESTS),
    rulesAgreedAt: typeof value.rulesAgreedAt === "string" ? value.rulesAgreedAt : "",
  };
}

export type StayApplicationCheck = { ok: true; application: StayApplicationAnswers } | { ok: false; error: string };

/**
 * Validates what the request page POSTs (`{purpose, message, guestNames, rulesAgreed: true}`) against the
 * head-count and stamps the agreement time. The agreement is required: a request without it is refused.
 */
export function checkStayApplication(raw: unknown, guests: number, now: Date = new Date()): StayApplicationCheck {
  // The head-count decides how many names are asked for, so it is checked BEFORE the list is built: an
  // unreadable or out-of-range count would otherwise ask for NaN names (or a thousand of them).
  if (!Number.isInteger(guests) || guests < 1 || guests > SHORT_STAY_MAX_GUESTS) {
    return { ok: false, error: "Choose how many guests." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Tell us about the stay." };
  const value = raw as Record<string, unknown>;
  const purpose = STAY_PURPOSES.find((candidate) => candidate.value === value.purpose)?.value;
  if (!purpose) return { ok: false, error: "Choose what the stay is for." };
  if (value.rulesAgreed !== true) return { ok: false, error: "Agree to the house rules to request this stay." };
  const names = Array.isArray(value.guestNames) ? value.guestNames.map((name) => clean(name, STAY_GUEST_NAME_MAX)) : [];
  const others = Math.max(0, guests - 1);
  if (names.length !== others || names.some((name) => !name)) {
    return { ok: false, error: others === 1 ? "Add the other guest's name." : "Add every other guest's name." };
  }
  return {
    ok: true,
    application: {
      purpose,
      message: typeof value.message === "string" ? value.message.trim().slice(0, STAY_MESSAGE_MAX) : "",
      guestNames: names,
      rulesAgreedAt: now.toISOString(),
    },
  };
}

/** The label / value lines the manager's hold draws. */
export function stayApplicationFacts(application: StayApplicationAnswers): Array<{ label: string; value: string }> {
  return [
    { label: "Purpose", value: stayPurposeLabel(application.purpose) },
    ...(application.guestNames.length ? [{ label: "Also staying", value: application.guestNames.join(", ") }] : []),
    ...(application.message ? [{ label: "Message", value: application.message }] : []),
    { label: "House rules", value: application.rulesAgreedAt ? "Agreed" : "Not recorded" },
  ];
}
