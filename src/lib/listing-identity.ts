/** Deterministic text normalization shared by listing routing and agent search. */
export function normalizeListingIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function normalizeListingWords(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function exactListingIdentityMatch(
  needle: string,
  identities: readonly (string | null | undefined)[],
): boolean {
  const normalizedNeedle = normalizeListingIdentity(needle);
  if (!normalizedNeedle) return false;
  return identities.some((identity) => normalizeListingIdentity(identity ?? "") === normalizedNeedle);
}
