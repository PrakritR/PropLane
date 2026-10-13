/**
 * The one naming rule for a workspace's work-email local part, as plain JS so
 * the backfill script and the server allocator share it. Keep RESERVED in step
 * with RESERVED_MAILBOX_LOCALS (tests/unit/workspace-mailbox-local-rule.test.ts
 * fails when they drift).
 */
export const RESERVED = [
  "support", "admin", "administrator", "postmaster", "abuse", "security", "noreply", "no-reply",
  "donotreply", "assistant", "assist", "reply", "help", "billing", "hello", "info", "contact",
  "sales", "team", "root", "webmaster", "hostmaster", "mailer-daemon", "proplane", "notifications",
];

const PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,30}[a-z0-9])?$/;

export function compactLetters(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
}

function usable(v) {
  return v.length >= 3 && v.length <= 32 && PATTERN.test(v) && !RESERVED.includes(v);
}

/** "SEATTLE HOMES" -> seattlehomes; short or reserved -> name + owner first name; "" if nothing usable. */
export function workspaceMailboxLocalFor(workspaceName, ownerFirstName) {
  const slug = compactLetters(workspaceName);
  if (usable(slug)) return slug;
  const combined = compactLetters(`${slug}${compactLetters(ownerFirstName)}`);
  return usable(combined) ? combined : "";
}
