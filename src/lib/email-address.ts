/**
 * Application / portal email shape checks.
 *
 * Requires a real-looking domain with a TLD of at least 2 letters so truncated
 * typos like `user@gmail.c` cannot create Incomplete rows or reminder targets.
 */
const LEGITIMATE_EMAIL_RE =
  /^[^\s@]+@[^\s@.]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})*$/i;

export function isLegitimateEmail(email: string): boolean {
  const t = email.trim();
  if (!t || t.length > 254) return false;
  if (t.includes("..")) return false;
  return LEGITIMATE_EMAIL_RE.test(t);
}
