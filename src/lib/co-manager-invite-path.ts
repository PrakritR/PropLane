/** Public accept page. Covered by the `/auth/` in-app prefix. */
export const CO_MANAGER_INVITE_PATH = "/auth/co-manager-invite";

export function coManagerOpenInvitePath(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return CO_MANAGER_INVITE_PATH;
  return `${CO_MANAGER_INVITE_PATH}?token=${encodeURIComponent(trimmed)}`;
}

/** Safe post-auth `next` target (sign-in / create-account return). */
export function isCoManagerInvitePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return false;
  try {
    const url = new URL(trimmed, "https://axis-internal.invalid");
    return url.pathname === CO_MANAGER_INVITE_PATH;
  } catch {
    return trimmed === CO_MANAGER_INVITE_PATH || trimmed.startsWith(`${CO_MANAGER_INVITE_PATH}?`);
  }
}
