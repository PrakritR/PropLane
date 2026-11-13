/**
 * Where a manager-added resident is on the way into the portal, pure half. Five steps, each done or not (with a time
 * when one is known): the link went out, the person opened it, their account exists, the lease is signed, a first
 * payment came in. Every one is read from the record's own state, never a counter the UI keeps.
 */
export type OnboardingStepId = "sent" | "opened" | "account" | "lease" | "payment";
export type OnboardingStep = { id: OnboardingStepId; label: string; done: boolean; at: string | null };
export type OnboardingProgress = { steps: OnboardingStep[]; emailSentAt: string | null; textSentAt: string | null };

export type OnboardingProgressInput = {
  /** `manualResidentDetails.onboardingWelcomeSentAt` on the application row. */
  emailSentAt?: string | null;
  /** Newest texted onboarding link for this record (`phone_bound_links`). */
  textLink?: { createdAt: string; openCount: number; usedAt: string | null } | null;
  /** The account bound to the application row (the emailed `token_hash` proof binds it). */
  residentUserId?: string | null;
  leaseSignedAt?: string | null;
  /** `paidAt` of each charge the RESIDENT paid (a Stripe checkout they completed). */
  residentPaidAts?: readonly (string | null | undefined)[];
};

const iso = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};
const earliest = (values: readonly (string | null)[]): string | null => {
  const real = values.filter((v): v is string => Boolean(v));
  return real.length ? real.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
};

export function deriveOnboardingProgress(input: OnboardingProgressInput): OnboardingProgress {
  const emailSentAt = iso(input.emailSentAt);
  const textSentAt = iso(input.textLink?.createdAt);
  const usedAt = iso(input.textLink?.usedAt);
  const accountExists = Boolean(usedAt || input.residentUserId);
  const sentAt = earliest([emailSentAt, textSentAt]);
  // Creating the account IS opening the link, so a missing open count never reads as "not opened" after that.
  const opened = Boolean((input.textLink?.openCount ?? 0) > 0 || accountExists);
  const payments = (input.residentPaidAts ?? []).map(iso).filter((v): v is string => Boolean(v));
  const leaseSignedAt = iso(input.leaseSignedAt);
  const firstPaymentAt = earliest(payments);
  return {
    emailSentAt,
    textSentAt,
    steps: [
      { id: "sent", label: "Link sent", done: Boolean(sentAt), at: sentAt },
      { id: "opened", label: "Link opened", done: opened, at: null },
      { id: "account", label: "Account created", done: accountExists, at: usedAt },
      { id: "lease", label: "Lease signed", done: Boolean(leaseSignedAt), at: leaseSignedAt },
      { id: "payment", label: "First payment", done: payments.length > 0, at: firstPaymentAt },
    ],
  };
}
