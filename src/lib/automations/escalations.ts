/**
 * The escalations inbox: shapes and pure rules, safe on the client.
 */

export type EscalationSource = "agent" | "ra" | "unanswered";
export type EscalationStatus = "open" | "resolved";

export const ESCALATION_SOURCE_LABELS: Record<EscalationSource, string> = {
  agent: "Assistant handed off",
  ra: "House group",
  unanswered: "Unanswered question",
};

export type EscalationItem = {
  id: string;
  source: EscalationSource;
  /** The asker's role: resident, applicant, prospect, vendor, manager. */
  role: string;
  topic: string;
  /** What was asked or reported, redacted. */
  question: string;
  /** The thread excerpt the manager reads. */
  excerpt: string;
  propertyId: string | null;
  houseLabel: string | null;
  /** Last four digits only. The number itself never leaves the server in this list. */
  phoneTail: string;
  escalatedAt: string;
  resolvedAt: string | null;
};

/** The window the complaint threshold counts over. */
export const COMPLAINT_WINDOW_DAYS = 30;

/**
 * Has the house hit its complaint threshold? `threshold` is the manager's number on House details
 * (null = none set, never escalate on count alone). Counts are complaints in the window including
 * the one just logged.
 */
export function complaintThresholdCrossed(count: number, threshold: number | null): boolean {
  return threshold !== null && threshold >= 1 && count >= threshold;
}

export function maskPhoneTail(phoneKey: string): string {
  const digits = String(phoneKey ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}
