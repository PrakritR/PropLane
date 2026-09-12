import { WORKSPACE_COOKIE } from "./types";

/**
 * The selected-workspace id from a raw `Cookie` header, or undefined.
 *
 * Read off the request rather than `next/headers` so route handlers stay
 * callable from plain unit tests (which construct a `Request` and never enter
 * a Next request scope).
 */
export function readWorkspaceCookie(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== WORKSPACE_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}
