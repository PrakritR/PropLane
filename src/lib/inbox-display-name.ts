/**
 * A sender as a person reads it. A conversation whose only known name is an email address
 * ("manager@test.proplane.local") shows the name part, spaced and capitalised ("Manager");
 * a real name is returned as it came.
 */
export function inboxDisplayName(name: string | null | undefined): string {
  const raw = (name ?? "").trim();
  if (!raw || /\s/.test(raw) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return raw;
  const local = raw.slice(0, raw.indexOf("@")).replace(/\+.*$/, "");
  const words = local.split(/[._-]+/).filter((word) => /[a-z]/i.test(word));
  if (words.length === 0) return raw;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}
