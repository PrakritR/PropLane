import { slugifyWorkspaceBrowseSlug } from "@/lib/workspace-browse-slug";

/** Query param on `/rent/w/<slug>` — short listing tokens (comma-separated). */
export const WORKSPACE_BROWSE_LIST_PARAM = "l";

/** Strip demo `prop_` prefix; real ids pass through unchanged. */
export function listingBrowseShortToken(propertyId: string): string {
  const id = propertyId.trim();
  if (!id) return "";
  return id.replace(/^prop_/i, "");
}

export function parseWorkspaceBrowseListParam(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Match a browse token against authorized public listing ids for one manager workspace.
 * Tokens may be the full id, the short token, or a suffix match (e.g. `alder` → `mgr-seed-alder-…`).
 */
export function resolveBrowseTokensToPropertyIds(
  tokens: readonly string[],
  authorizedPropertyIds: readonly string[],
): string[] {
  if (!tokens.length || !authorizedPropertyIds.length) return [];
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const t = token.trim().toLowerCase();
    if (!t) continue;
    const match =
      authorizedPropertyIds.find((id) => id.toLowerCase() === t) ??
      authorizedPropertyIds.find((id) => listingBrowseShortToken(id).toLowerCase() === t) ??
      authorizedPropertyIds.find((id) => id.toLowerCase().endsWith(t) || id.toLowerCase().includes(t));
    if (match && !seen.has(match)) {
      seen.add(match);
      resolved.push(match);
    }
  }
  return resolved;
}

export function buildWorkspaceBrowsePath(workspaceSlug: string, propertyIds: string[]): string {
  const slug = slugifyWorkspaceBrowseSlug(workspaceSlug);
  const tokens = propertyIds.map(listingBrowseShortToken).filter(Boolean);
  if (!slug || tokens.length === 0) return "/rent/browse";
  const q = new URLSearchParams({ [WORKSPACE_BROWSE_LIST_PARAM]: tokens.join(",") });
  return `/rent/w/${encodeURIComponent(slug)}?${q.toString()}`;
}

export function buildWorkspaceBrowseUrl(origin: string, workspaceSlug: string, propertyIds: string[]): string {
  const base = origin.replace(/\/$/, "");
  return `${base}${buildWorkspaceBrowsePath(workspaceSlug, propertyIds)}`;
}
