/**
 * A resident the file names without an email still becomes a real resident.
 *
 * Every resident-facing read is scoped on `resident_email`, and orphan-purge
 * sweeps drop application rows with no email — so an imported resident with
 * no address would silently vanish. Reuses the exact placeholder domain the
 * pre-rebuild import used (`@import.proplane.local`), which
 * `isPlaceholderResidentEmail` (`src/lib/resident-welcome.server.ts`) already
 * recognizes and skips for outbound mail. The import also leaves a
 * `missing_contact` task so the manager can add the real address.
 */

export const PORTFOLIO_IMPORT_PLACEHOLDER_EMAIL_DOMAIN = "import.proplane.local";

export function isPlaceholderImportEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.trim().toLowerCase().endsWith(`@${PORTFOLIO_IMPORT_PLACEHOLDER_EMAIL_DOMAIN}`);
}

export function placeholderImportEmail(nameSlug: string, hash: string): string {
  const local = `${nameSlug || "resident"}-${hash}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${local}@${PORTFOLIO_IMPORT_PLACEHOLDER_EMAIL_DOMAIN}`;
}
