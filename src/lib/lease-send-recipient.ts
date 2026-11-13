import { isPlaceholderImportEmail } from "@/lib/portfolio-import/placeholder-email";

/**
 * A lease is signed by a person who gets the link. An import placeholder address
 * (`...@import.proplane.local`) is not a mailbox, so a lease "sent" there reaches nobody and
 * still flips to Resident Signature Pending. One predicate for the gate, the route, the agent
 * tool and the row glyph, so none of them can disagree about which addresses are real.
 */
export const LEASE_PLACEHOLDER_EMAIL_MESSAGE =
  "This resident has no real email address, so the lease link would reach nobody. Add one in Edit resident (Email), then send the lease.";

export function leaseRecipientHasRealEmail(row: { residentEmail?: string | null }): boolean {
  const email = (row.residentEmail ?? "").trim();
  return email.includes("@") && !isPlaceholderImportEmail(email);
}

/** True only for an address that is PRESENT and a placeholder (an empty one has its own refusal). */
export function leaseRecipientIsPlaceholder(row: { residentEmail?: string | null }): boolean {
  return isPlaceholderImportEmail(row.residentEmail);
}

export function leaseRecipientEmailBlocker(row: { residentEmail?: string | null }): string | null {
  return leaseRecipientIsPlaceholder(row) ? LEASE_PLACEHOLDER_EMAIL_MESSAGE : null;
}
