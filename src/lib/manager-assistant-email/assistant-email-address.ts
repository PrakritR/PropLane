import { randomBytes } from "node:crypto";

const ASSISTANT_LOCAL_PREFIX = "assistant";
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{8,24}$/;

/**
 * The custom local part a manager may type for their workspace's work email
 * (e.g. `frontdesk@…`), not just the auto-generated `assist-<slug>` form.
 * Lowercase letters, digits, dots and hyphens; must start and end
 * alphanumeric. `isValidMailboxLocal` is the authoritative business rule
 * (length 3-32); this raw pattern also matches the character-class shape
 * `assistant-mailbox-local.server.ts` builds default `assist-<slug>` locals
 * from.
 */
export const MAILBOX_LOCAL_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,30}[a-z0-9])?$/;

/** 3-32 chars, matching {@link MAILBOX_LOCAL_PATTERN}. The one gate every caller uses. */
export function isValidMailboxLocal(local: string): boolean {
  const trimmed = local.trim().toLowerCase();
  return (
    trimmed.length >= 3 &&
    trimmed.length <= 32 &&
    !trimmed.includes("+") &&
    MAILBOX_LOCAL_PATTERN.test(trimmed)
  );
}

/**
 * Local parts nobody may claim as a custom work-email address, either
 * because they read as an official PropLane mailbox or because they collide
 * with the legacy `assistant+<token>` scheme's own prefix.
 */
export const RESERVED_MAILBOX_LOCALS: ReadonlySet<string> = new Set([
  "support",
  "admin",
  "administrator",
  "postmaster",
  "abuse",
  "security",
  "noreply",
  "no-reply",
  "donotreply",
  "assistant",
  "assist",
  "reply",
  "help",
  "billing",
  "hello",
  "info",
  "contact",
  "sales",
  "team",
  "root",
  "webmaster",
  "hostmaster",
  "mailer-daemon",
  "proplane",
  "notifications",
]);

export function isReservedMailboxLocal(local: string): boolean {
  return RESERVED_MAILBOX_LOCALS.has(local.trim().toLowerCase());
}

export function assistantEmailDomain(): string {
  return (
    process.env.ASSISTANT_EMAIL_DOMAIN?.trim() ||
    process.env.INBOUND_EMAIL_DOMAIN?.trim() ||
    "prop-lane.space"
  ).toLowerCase();
}

/** Legacy plus-addressed assistant mailbox (still accepted for inbound). */
export function assistantEmailAddress(token: string): string {
  return `${ASSISTANT_LOCAL_PREFIX}+${token}@${assistantEmailDomain()}`;
}

/** Shareable work address: assist-jane-smith@prop-lane.space */
export function assistantMailboxAddress(mailboxLocal: string): string {
  return `${mailboxLocal.trim().toLowerCase()}@${assistantEmailDomain()}`;
}

/** Extract inbox token from `assistant+<token>@…` in any To/Cc address. */
export function extractAssistantEmailToken(addresses: string[]): string | null {
  for (const raw of addresses) {
    const email = raw.trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (at <= 0) continue;
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    if (domain !== assistantEmailDomain()) continue;
    const plus = local.indexOf("+");
    if (plus === -1) continue;
    const prefix = local.slice(0, plus);
    if (prefix !== ASSISTANT_LOCAL_PREFIX) continue;
    const token = local.slice(plus + 1);
    if (TOKEN_PATTERN.test(token)) return token;
  }
  return null;
}

/**
 * Readable local part from `<local>@domain` (not legacy plus addressing).
 * No longer requires the `assist-` prefix — a manager may have renamed the
 * workspace's mailbox local part to anything valid via `set_address`. A
 * reserved local (`support`, `admin`, …) is never matched here either, since
 * no active row may ever hold one — this is the gate `isAssistantEmailAddress`
 * uses to decide whether an inbound message is even in this feature's domain,
 * so `support@…`/`admin@…` must fall through to it, not be swallowed and
 * silently dropped for want of a matching row.
 */
export function extractAssistantMailboxLocal(addresses: string[]): string | null {
  for (const raw of addresses) {
    const email = raw.trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (at <= 0) continue;
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    if (domain !== assistantEmailDomain()) continue;
    if (local.includes("+")) continue;
    if (isReservedMailboxLocal(local)) continue;
    if (isValidMailboxLocal(local)) return local;
  }
  return null;
}

export function isAssistantEmailAddress(addresses: string[]): boolean {
  return (
    extractAssistantEmailToken(addresses) !== null ||
    extractAssistantMailboxLocal(addresses) !== null
  );
}

export function generateAssistantEmailToken(): string {
  return randomBytes(9).toString("base64url").slice(0, 12);
}

export { TOKEN_PATTERN as ASSISTANT_EMAIL_TOKEN_PATTERN };
