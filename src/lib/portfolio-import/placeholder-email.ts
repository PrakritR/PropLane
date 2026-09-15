/**
 * A resident the file names without an email still becomes a real resident.
 *
 * Every resident-facing read is scoped on `resident_email`, and the Residents
 * and Payments tabs purge application rows with no email as orphans
 * (`purge-manager-resident-orphans.ts`) — so an imported resident with no
 * address would silently vanish. The Airbnb occupancy import already solved
 * this with the `@import.proplane.local` placeholder domain, which that purge
 * explicitly protects. Same convention here: a deterministic placeholder that
 * never receives mail, replaced when the manager adds the real address
 * (the import also leaves an "Add an email" task).
 */

export const PORTFOLIO_IMPORT_PLACEHOLDER_EMAIL_DOMAIN = "import.proplane.local";

export function isPlaceholderImportEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.trim().toLowerCase().endsWith(`@${PORTFOLIO_IMPORT_PLACEHOLDER_EMAIL_DOMAIN}`);
}

export function placeholderImportEmail(nameSlug: string, hash: string): string {
  const local = `${nameSlug || "resident"}-${hash}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${local}@${PORTFOLIO_IMPORT_PLACEHOLDER_EMAIL_DOMAIN}`;
}
