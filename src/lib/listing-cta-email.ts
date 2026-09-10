/**
 * The public listing's "Email" CTA — the email twin of `buildSmsDeepLink`.
 *
 * A prospect who emails a manager's work email reaches the leasing assistant
 * (`runLeasingEmailAgentTurn`), which answers from the public catalog. That
 * assistant has existed, tested and wired, since the work email shipped — and
 * no surface in the product ever showed a prospect the address, so it could
 * never actually be reached. This is the door.
 *
 * Pure and client-safe: the address is resolved server-side and arrives on the
 * public listing payload, exactly like `contactSmsPhone`.
 */

export type ListingCtaEmailIntent = "tour" | "apply" | "question";

/**
 * A work email safe to render as a `mailto:`, or null.
 *
 * Only the PropLane work address ever reaches this — never a manager's personal
 * profile email — because the point is that inbound lands in the leasing inbox
 * with an assistant on it, not in someone's private mailbox.
 */
export function listingCtaEmailAddress(value: string | null | undefined): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || /\s/.test(email)) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  // A trailing-dot domain ("a@b.") passes a naive `.includes(".")` and renders a
  // mailto: no mail client can send, so require a real TLD label.
  if (!/^[^@.][^@]*\.[a-z]{2,}$/.test(email.slice(at + 1))) return null;
  return email;
}

export function isListingCtaEmailEnabled(value: string | null | undefined): boolean {
  return listingCtaEmailAddress(value) !== null;
}

/**
 * A prefilled `mailto:` for one listing, or `"#"` when there is no usable
 * address — the callers omit the button in that case, so no dead link renders.
 */
export function buildListingEmailDeepLink(args: {
  intent: ListingCtaEmailIntent;
  propertyLabel?: string | null;
  topic?: string | null;
  toEmail?: string | null;
}): string {
  const toEmail = listingCtaEmailAddress(args.toEmail);
  if (!toEmail) return "#";
  const label = (args.propertyLabel ?? "").trim();
  const topic = (args.topic ?? "").trim();

  let subject = label ? `Question about ${label}` : "Question about your listing";
  let body = "Hi — I'm interested in your listing.";
  if (args.intent === "tour") {
    subject = label ? `Tour request — ${label}` : "Tour request";
    body = label ? `Hi — I'd like to schedule a tour for ${label}.` : "Hi — I'd like to schedule a tour.";
  } else if (args.intent === "apply") {
    subject = label ? `Application — ${label}` : "Application";
    body = label ? `Hi — I'd like to apply for ${label}.` : "Hi — I'd like to apply.";
  } else if (topic) {
    subject = label ? `Question about ${topic} — ${label}` : `Question about ${topic}`;
    body = label
      ? `Hi — I have a question about ${topic} at ${label}.`
      : `Hi — I have a question about ${topic}.`;
  }

  return `mailto:${toEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
