/**
 * Settings → Services: the knobs that are not reminder rules.
 *
 * A reminder rule answers "is it on, when, who, via what". These answer the
 * other questions the vendor loop needs — how long an offer stays open, what
 * we promise the resident, whether we ask them to confirm the fix — and they
 * drive ACTIONS (an offer flipping to expired, a work order auto-closing), not
 * just messages. Stored in `manager_automation_settings.row_data.serviceAutomation`
 * beside `reminderRules`; pure so the panel and the sweepers share it.
 */

export type ServiceResponsePromise = "4_hours" | "1_business_day" | "2_days" | "none";

export type ServiceAutomationSettings = {
  /** What the resident is told to expect when they file a request. */
  responsePromise: ServiceResponsePromise;
  /** Hours an offer stays open before it expires; 0 = never expires. */
  offerExpiryHours: 0 | 4 | 12 | 24 | 48;
  /** Tell the manager when an offer expired with no acceptance. */
  notifyWhenNoVendorAnswers: boolean;
  /** Vendors are expected to tap On my way; the manager is told when they do not. */
  requireOnMyWay: boolean;
  /** Ask the resident "was this fixed?" when the vendor marks it done. */
  residentConfirmation: boolean;
  /** Hours of silence after which the confirmation request closes itself; 0 = never. */
  autoCloseHours: 0 | 24 | 48 | 72;
  /** Whether a resident's rating is relayed to the vendor. */
  shareRatingsWithVendors: boolean;
};

export const DEFAULT_SERVICE_AUTOMATION_SETTINGS: ServiceAutomationSettings = {
  responsePromise: "1_business_day",
  offerExpiryHours: 24,
  notifyWhenNoVendorAnswers: true,
  requireOnMyWay: false,
  residentConfirmation: true,
  autoCloseHours: 48,
  shareRatingsWithVendors: false,
};

export const RESPONSE_PROMISE_OPTIONS: { value: ServiceResponsePromise; label: string; phrase: string }[] = [
  { value: "1_business_day", label: "Respond within 1 business day", phrase: "within 1 business day" },
  { value: "4_hours", label: "Respond within 4 hours", phrase: "within 4 hours" },
  { value: "2_days", label: "Respond within 2 days", phrase: "within 2 days" },
  { value: "none", label: "No promise", phrase: "" },
];

export const OFFER_EXPIRY_OPTIONS: { value: ServiceAutomationSettings["offerExpiryHours"]; label: string }[] = [
  { value: 24, label: "After 24 hours" },
  { value: 4, label: "After 4 hours" },
  { value: 12, label: "After 12 hours" },
  { value: 48, label: "After 48 hours" },
  { value: 0, label: "Never" },
];

export const AUTO_CLOSE_OPTIONS: { value: ServiceAutomationSettings["autoCloseHours"]; label: string }[] = [
  { value: 48, label: "Close after 48 hours" },
  { value: 24, label: "Close after 24 hours" },
  { value: 72, label: "Close after 72 hours" },
  { value: 0, label: "Never auto-close" },
];

export function responsePromisePhrase(value: ServiceResponsePromise): string {
  return RESPONSE_PROMISE_OPTIONS.find((option) => option.value === value)?.phrase ?? "";
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function oneOf<T>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(raw) ? (raw as T) : fallback;
}

export function normalizeServiceAutomationSettings(raw: unknown): ServiceAutomationSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SERVICE_AUTOMATION_SETTINGS;
  return {
    responsePromise: oneOf(row.responsePromise, ["4_hours", "1_business_day", "2_days", "none"] as const, d.responsePromise),
    offerExpiryHours: oneOf(row.offerExpiryHours, [0, 4, 12, 24, 48] as const, d.offerExpiryHours),
    notifyWhenNoVendorAnswers: bool(row.notifyWhenNoVendorAnswers, d.notifyWhenNoVendorAnswers),
    requireOnMyWay: bool(row.requireOnMyWay, d.requireOnMyWay),
    residentConfirmation: bool(row.residentConfirmation, d.residentConfirmation),
    autoCloseHours: oneOf(row.autoCloseHours, [0, 24, 48, 72] as const, d.autoCloseHours),
    shareRatingsWithVendors: bool(row.shareRatingsWithVendors, d.shareRatingsWithVendors),
  };
}

/** When an offer sent now expires, or null when offers never expire. */
export function offerExpiresAt(settings: ServiceAutomationSettings, sentAt: Date): Date | null {
  if (!settings.offerExpiryHours) return null;
  return new Date(sentAt.getTime() + settings.offerExpiryHours * 60 * 60_000);
}
