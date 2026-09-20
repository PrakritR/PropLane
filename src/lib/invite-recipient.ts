import { normalizeE164, formatSmsPhoneLabel } from "@/lib/phone-e164";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";

export type InviteRecipient =
  | { kind: "empty" }
  | { kind: "phone"; value: string; label: string }
  | { kind: "email"; value: string; label: string }
  | { kind: "code"; value: string; label: string }
  | { kind: "name"; value: string };

/**
 * Parse raw input into a typed InviteRecipient.
 *
 * Tries in order: empty, email, phone, PropLane code, name.
 * Email requires "@" and a simple regex match.
 * Phone uses normalizeE164; PropLane codes use proplaneIdLookupVariants.
 */
export function parseInviteRecipient(raw: string): InviteRecipient {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };

  // Email: contains "@" and passes a simple regex.
  if (trimmed.includes("@")) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(trimmed)) {
      return {
        kind: "email",
        value: trimmed.toLowerCase().trim(),
        label: trimmed.toLowerCase().trim(),
      };
    }
  }

  // Phone: try normalizeE164.
  const phoneE164 = normalizeE164(trimmed);
  if (phoneE164) {
    const label = formatSmsPhoneLabel(phoneE164);
    return {
      kind: "phone",
      value: phoneE164,
      label: label ?? phoneE164,
    };
  }

  // PropLane code: the current PROPLANE- form, the legacy AXIS- form, and the
  // seeded MGR- ids all resolve through the same server lookup.
  const upperInput = trimmed.toUpperCase();
  if (/^(PROPLANE|AXIS|MGR)-[A-Z0-9]{4,}$/.test(upperInput)) {
    // Normalize to the display form.
    const displayForm = formatProplaneIdForDisplay(trimmed);
    return {
      kind: "code",
      value: trimmed,
      label: displayForm,
    };
  }

  // Default: treat as a name.
  return { kind: "name", value: trimmed };
}

/**
 * Return a human-readable hint for what will happen if this recipient is invited.
 */
export function inviteRecipientHint(r: InviteRecipient): string {
  switch (r.kind) {
    case "empty":
      return "Add a phone, an email or a PropLane code";
    case "phone":
      return `Will text ${r.label}`;
    case "email":
      return `Will email ${r.value}`;
    case "code":
      return `Will invite ${r.label} in PropLane`;
    case "name":
      return "Add a phone, an email or a PropLane code";
  }
}
