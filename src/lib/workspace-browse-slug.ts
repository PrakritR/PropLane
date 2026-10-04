/** Human-readable slug for `/rent/w/<slug>` combined listing links. */
export function slugifyWorkspaceBrowseSlug(workspaceName: string): string {
  return String(workspaceName || "workspace")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // Single `-`, not `-+`: the collapse above never leaves two dashes in a row,
    // and `-+$` rescanned the whole run from every position (CodeQL
    // js/polynomial-redos).
    .replace(/^-|-$/g, "");
}
