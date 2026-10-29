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
  "stripe", "paypal", "venmo", "zelle", "chase", "wellsfargo", "bankofamerica", "bank", "payments",
  "invoice", "invoices", "legal", "airbnb", "zillow", "booking", "apple", "google", "microsoft", "amazon", "irs",
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

const ORDINAL_PREFIX = /^\s*#?\s*\d+\s*(?:[.)\]:]|\s[-–—])\s*/;

/**
 * PropLane-managed (service) workspaces are named "1. Ambika", "2. Vinod": the work email is the client's name
 * plus "homes" -> ambikahomes, vinodhomes. The leading ordinal ("1. ", "12) ", "#3 - ") is dropped, only letters
 * are kept, and "homes" is appended unless the name already ends with it ("Seattle Homes" -> seattlehomes).
 * An unusable result (all digits, too long, reserved) falls back to the self-serve rule. "" if nothing usable.
 */
export function serviceWorkspaceMailboxLocalFor(workspaceName, ownerFirstName) {
  const letters = String(workspaceName ?? "")
    .replace(ORDINAL_PREFIX, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (letters) {
    const candidate = letters.endsWith("homes") ? letters : `${letters}homes`;
    if (usable(candidate)) return candidate;
  }
  return workspaceMailboxLocalFor(workspaceName, ownerFirstName);
}

/**
 * `local` is `base`, or `base` plus the suffix the allocator adds on a collision (-2..-9, or -<4-char token>).
 * Both bases are letters and digits only, so they are safe inside a pattern.
 */
export function localFollowsBase(local, base) {
  const current = String(local ?? "").trim().toLowerCase();
  return base !== "" && (current === base || new RegExp(`^${base}-(?:[2-9]|[a-z0-9]{4})$`).test(current));
}

/**
 * True when `local` is what a naming rule would have given `workspaceName` on its own (the service rule or the
 * self-serve one, with or without the -2..-9 collision suffix) - i.e. nobody customized the address. A rename of a
 * workspace re-derives only such an address.
 */
export function mailboxLocalIsDerivedFrom(workspaceName, ownerFirstName, local) {
  const bases = [serviceWorkspaceMailboxLocalFor(workspaceName, ownerFirstName), workspaceMailboxLocalFor(workspaceName, ownerFirstName)];
  return bases.some((base) => localFollowsBase(local, base));
}
