/** Filesystem-safe download name for an application PDF. */
export function applicationPdfFilename(row: { id: string; name: string }): string {
  const name = row.name
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const id = row.id.trim().replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const base = [name || "application", id].filter(Boolean).join("-");
  return `${base}.pdf`;
}
