/**
 * What this DEVICE last used to sign in, for the sign-in screen only (same pattern as the remembered email: plain
 * localStorage, `axis:` prefix so `clearPortalBrowserCache` clears every key here with the rest). Storage can throw or
 * be absent (private windows, blocked site data), so every access is wrapped and the screen works without it.
 */
export const REMEMBERED_LOGIN_EMAIL_KEY = "axis:remembered-login-email";
export const REMEMBERED_LOGIN_PHONE_KEY = "axis:remembered-login-phone";
export const LAST_LOGIN_METHOD_KEY = "axis:last-login-method";

export type LoginMethod = "phone" | "email";

function read(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export const readRememberedLoginEmail = () => read(REMEMBERED_LOGIN_EMAIL_KEY);
export const readRememberedLoginPhone = () => read(REMEMBERED_LOGIN_PHONE_KEY);
export const rememberLoginPhone = (display: string) => write(REMEMBERED_LOGIN_PHONE_KEY, display);

export function rememberLoginMethod(method: LoginMethod) {
  write(LAST_LOGIN_METHOD_KEY, method);
}

/** "email" when this device last signed in by email (or only ever stored an email), "phone" likewise, null when unknown. */
export function readLastLoginMethod(): LoginMethod | null {
  const stored = read(LAST_LOGIN_METHOD_KEY);
  if (stored === "email" || stored === "phone") return stored;
  const hasEmail = Boolean(read(REMEMBERED_LOGIN_EMAIL_KEY));
  const hasPhone = Boolean(read(REMEMBERED_LOGIN_PHONE_KEY));
  if (hasEmail && !hasPhone) return "email";
  if (hasPhone && !hasEmail) return "phone";
  return null;
}
