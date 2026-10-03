/** Human-readable slug for `/rent/w/<slug>` combined listing links. */
export function slugifyWorkspaceBrowseSlug(workspaceName: string): string {
  return String(workspaceName || "workspace")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
