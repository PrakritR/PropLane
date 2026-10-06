import { parseMoneyAmount } from "@/lib/parse-money";

/**
 * Pure helpers behind the service header's Send to phone / Publish to vendors popups (vendor-work-share-1006).
 * Copy says "service", never "work order".
 */

/**
 * Send to phone is enabled with a full phone number, an unopted-out number, and - only while the first text
 * to that number still needs it - the manager's "I work with this vendor" attestation.
 */
export function canSendToPhone(input: {
  phone: string;
  attestWorksWithVendor: boolean;
  /** Unknown (still checking) counts as needed. */
  attestationNeeded?: boolean;
  optedOut?: boolean;
}): boolean {
  if (input.optedOut) return false;
  const attested = input.attestationNeeded === false || input.attestWorksWithVendor;
  return attested && input.phone.replace(/\D/g, "").length >= 10;
}

/** The optional "Up to" budget: blank or non-positive is none, otherwise whole cents. */
export function publishBudgetCents(raw: string): number | null {
  if (!raw.trim()) return null;
  const dollars = parseMoneyAmount(raw);
  return dollars > 0 ? Math.round(dollars * 100) : null;
}

/** The toast after a send: a sandbox capture says nothing was delivered. */
export function sendToPhoneToast(res: { sandbox?: unknown }): string {
  return res.sandbox ? "Sent (sandbox: captured, nothing delivered)" : "Sent";
}

/** A service can be sent to a phone or published only while it is Open, unassigned and not closed out. */
export function canShareService(input: {
  stage: string;
  hasAssignee: boolean;
  status?: string | null;
}): boolean {
  if (input.stage !== "open" || input.hasAssignee) return false;
  const status = (input.status ?? "").trim().toLowerCase();
  return status !== "cancelled" && status !== "completed";
}
