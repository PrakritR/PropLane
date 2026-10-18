/**
 * Vendor roles and the issues a dispatch rule can target (vendor-dispatch-1018).
 * The one taxonomy: the rule editor, vendor profiles, triage and the dispatch
 * engine all read it. Research: docs/agents/vendor-dispatch-research.md.
 */

export type DispatchUrgency = "emergency" | "urgent" | "routine";

export type VendorTrade =
  | "tour_host"
  | "cleaner"
  | "locksmith"
  | "plumber"
  | "electrician"
  | "hvac"
  | "appliance"
  | "handyman"
  | "pest"
  | "landscaping"
  | "junk_removal"
  | "general";

export type TradeIssue = { id: string; label: string; urgency: DispatchUrgency };

export type TradeDefinition = {
  id: VendorTrade;
  label: string;
  issues: readonly TradeIssue[];
  /** What the vendor sends back to close the job. */
  proof: "photos" | "checklist_photos" | "check_in";
  defaultPayModel: "flat" | "hourly" | "per_room" | "quote";
};

export const VENDOR_TRADES: readonly TradeDefinition[] = [
  {
    id: "tour_host",
    label: "Tour host",
    issues: [{ id: "tour", label: "Prospect tour", urgency: "routine" }],
    proof: "check_in",
    defaultPayModel: "flat",
  },
  {
    id: "cleaner",
    label: "Cleaner",
    issues: [
      { id: "turnover", label: "Turnover after checkout", urgency: "urgent" },
      { id: "deep_clean", label: "Deep clean", urgency: "routine" },
      { id: "common_area", label: "Common areas", urgency: "routine" },
    ],
    proof: "checklist_photos",
    defaultPayModel: "per_room",
  },
  {
    id: "locksmith",
    label: "Locksmith",
    issues: [
      { id: "lockout", label: "Lockout", urgency: "emergency" },
      { id: "rekey", label: "Rekey", urgency: "routine" },
      { id: "broken_lock", label: "Broken lock", urgency: "urgent" },
    ],
    proof: "photos",
    defaultPayModel: "flat",
  },
  {
    id: "plumber",
    label: "Plumber",
    issues: [
      { id: "leak", label: "Leak or flood", urgency: "emergency" },
      { id: "clog", label: "Clog", urgency: "urgent" },
      { id: "no_hot_water", label: "No hot water", urgency: "urgent" },
      { id: "fixture", label: "Fixture repair", urgency: "routine" },
    ],
    proof: "photos",
    defaultPayModel: "quote",
  },
  {
    id: "electrician",
    label: "Electrician",
    issues: [
      { id: "outage", label: "Power out", urgency: "urgent" },
      { id: "sparking", label: "Sparking or burning smell", urgency: "emergency" },
      { id: "fixture", label: "Outlet or light", urgency: "routine" },
    ],
    proof: "photos",
    defaultPayModel: "quote",
  },
  {
    id: "hvac",
    label: "Heating and cooling",
    issues: [
      { id: "no_heat", label: "No heat", urgency: "urgent" },
      { id: "no_cooling", label: "No cooling", urgency: "routine" },
    ],
    proof: "photos",
    defaultPayModel: "quote",
  },
  {
    id: "appliance",
    label: "Appliance repair",
    issues: [{ id: "broken_appliance", label: "Broken appliance", urgency: "urgent" }],
    proof: "photos",
    defaultPayModel: "quote",
  },
  {
    id: "handyman",
    label: "Handyman",
    issues: [
      { id: "repair", label: "General repair", urgency: "routine" },
      { id: "alarm_chirp", label: "Smoke or CO alarm chirp", urgency: "urgent" },
    ],
    proof: "photos",
    defaultPayModel: "hourly",
  },
  {
    id: "pest",
    label: "Pest control",
    issues: [{ id: "pests", label: "Pests", urgency: "urgent" }],
    proof: "photos",
    defaultPayModel: "flat",
  },
  {
    id: "landscaping",
    label: "Landscaping and snow",
    issues: [
      { id: "yard", label: "Yard", urgency: "routine" },
      { id: "snow", label: "Snow or ice", urgency: "urgent" },
    ],
    proof: "photos",
    defaultPayModel: "flat",
  },
  {
    id: "junk_removal",
    label: "Junk removal",
    issues: [{ id: "haul", label: "Haul away", urgency: "routine" }],
    proof: "photos",
    defaultPayModel: "quote",
  },
  {
    id: "general",
    label: "General",
    issues: [{ id: "other", label: "Other", urgency: "routine" }],
    proof: "photos",
    defaultPayModel: "quote",
  },
] as const;

/** Minutes a vendor has to answer before the next one is offered. */
export const DEFAULT_OFFER_TIMEOUT_MINUTES: Record<DispatchUrgency, number> = {
  emergency: 10,
  urgent: 30,
  routine: 120,
};

/** Minutes before an unanswered manager approval is resent, then escalated to the next teammate. */
export const APPROVAL_REMINDER_MINUTES: Record<DispatchUrgency, { resend: number; escalate: number }> = {
  emergency: { resend: 5, escalate: 10 },
  urgent: { resend: 15, escalate: 45 },
  routine: { resend: 120, escalate: 24 * 60 },
};

/** Issues where nobody is dispatched by the AI: 911 / utility first, the team takes it. */
export const NEVER_AUTO_DISPATCH_ISSUES = new Set(["gas_smell", "fire", "noise"]);

export function tradeDefinition(trade: string): TradeDefinition | null {
  return VENDOR_TRADES.find((entry) => entry.id === trade) ?? null;
}

export function issueDefinition(trade: string, issue: string | null | undefined): TradeIssue | null {
  if (!issue) return null;
  return tradeDefinition(trade)?.issues.find((entry) => entry.id === issue) ?? null;
}
