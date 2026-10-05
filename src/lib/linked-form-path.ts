/**
 * The two paths a linked form is opened from. Dependency-free on purpose: the post-sign-in redirect guards
 * import it, and they must stay light.
 */

/** The public path a share link opens. The token is a path segment, never a query string. */
export function linkedFormSharePath(token: string): string {
  return `/f/${encodeURIComponent(token)}`;
}

/** True for `/f/<token>` or `/f/open/<request id>`, the two shapes a post-sign-in redirect may return to. */
export function isLinkedFormSharePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return false;
  try {
    const url = new URL(trimmed, "https://axis-internal.invalid");
    return /^\/f\/(?:open\/[0-9a-f-]{36}|[A-Za-z0-9_-]{20,128})$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/** The session-scoped fill page (no token): the applicant, and the helper who already opened a link, use it. */
export function linkedFormOpenPath(requestId: string): string {
  return `/f/open/${encodeURIComponent(requestId)}`;
}
