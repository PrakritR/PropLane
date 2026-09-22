/** Safe in-app path for Google OAuth connect/callback return (no open redirect). */
export function sanitizeOAuthReturnPath(path: string | null | undefined, fallback: string): string {
  const trimmed = path?.trim() ?? "";
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return fallback;
  if (trimmed.includes("://")) return fallback;
  const [pathPart, queryPart] = trimmed.split("?");
  const pathname = pathPart?.split("#")[0] ?? "";
  if (!pathname.startsWith("/auth/") && !pathname.startsWith("/portal/")) return fallback;
  const query = (queryPart ?? "").split("#")[0] ?? "";
  if (query && /^tab=[a-z0-9_-]+$/i.test(query)) return `${pathname}?${query}`;
  return pathname || fallback;
}
