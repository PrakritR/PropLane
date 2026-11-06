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

// Written so no two repetitions can consume the same whitespace: `#` is mandatory inside its own group (an
// absent `#` leaves one leading `\s*`, not two), and the dash branch owns its `\s+`. The ambiguous
// `\s*#?\s*` this replaces matched the same names but backtracked quadratically on a name of pure
// whitespace, which a workspace name is free to be (CodeQL js/polynomial-redos).
const ORDINAL_PREFIX = /^\s*(?:#\s*)?\d+(?:\s*[.)\]:]|\s+[-–—])\s*/;

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
 * True when `local` is exactly what the SERVICE rule would have given `workspaceName` (with or without the
 * allocator's collision suffix) - i.e. PropLane minted it for this name and nobody has moved it since. A rename of
 * a service workspace re-derives only such an address.
 *
 * Deliberately NOT the self-serve rule as well. A workspace that ran self-serve before PropLane took it over was
 * minted `{workspace-slug}@` by `ensureOwnedWorkspaceAssistantEmails`, and that address is already published - on
 * listings, in syndication posts, in the public listing payload. Treating it as "never customized" let a rename
 * move a live address, leaving the old local as a 30-day alias and bouncing every reply after that.
 */
export function mailboxLocalIsDerivedFrom(workspaceName, ownerFirstName, local) {
  return localFollowsBase(local, serviceWorkspaceMailboxLocalFor(workspaceName, ownerFirstName));
}
