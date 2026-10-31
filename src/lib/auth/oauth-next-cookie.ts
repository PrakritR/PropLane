import type { NextRequest, NextResponse } from "next/server";

import { normalizePostAuthPath } from "@/lib/auth/normalize-post-auth-path";
import {
  OAUTH_INTENT_COOKIE,
  OAUTH_INTENT_STORAGE_KEY,
  OAUTH_SURFACE_COOKIE,
  OAUTH_SURFACE_STORAGE_KEY,
  defaultOAuthNextPath,
  parseOAuthSignInIntent,
  parseOAuthSurface,
  type OAuthSignInIntent,
  type OAuthSurface,
} from "@/lib/auth/post-oauth-routing";
import { detectNativePlatformSync } from "@/lib/native/detect-native";

/** Short-lived cookie holding the post-OAuth path (avoids ?next= on redirect URLs). */
export const OAUTH_NEXT_COOKIE = "axis_oauth_next";
export const OAUTH_NEXT_STORAGE_KEY = "axis_oauth_next";
const MAX_AGE_SEC = 600;

function writeClientCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${MAX_AGE_SEC}; SameSite=Lax`;
}

function clearClientCookie(name: string): void {
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
}

/** Base64-encode the path before persisting to sessionStorage (avoids storing it as cleartext). */
function encodeStoredPath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeStoredPath(encoded: string): string | null {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function persistOAuthNextPath(path: string): void {
  if (typeof document === "undefined") return;
  const normalized = normalizePostAuthPath(path);
  if (!normalized.startsWith("/") || normalized === "/auth/continue") return;
  writeClientCookie(OAUTH_NEXT_COOKIE, normalized);
  try {
    sessionStorage.setItem(OAUTH_NEXT_STORAGE_KEY, encodeStoredPath(normalized));
  } catch {
    /* private mode / WebView restrictions */
  }
}

/** Persist sign-in intent + native/web surface for OAuth return routing. */
export function persistOAuthSignInContext(options: {
  nextPath?: string;
  intent?: OAuthSignInIntent | null;
  surface?: OAuthSurface | null;
}): void {
  if (typeof document === "undefined") return;

  const intent = options.intent ?? null;
  const surface =
    options.surface ?? (detectNativePlatformSync() || document.documentElement.hasAttribute("data-native") ? "native" : "web");

  const next = normalizePostAuthPath(
    options.nextPath?.startsWith("/") ? options.nextPath : defaultOAuthNextPath(intent),
  );

  if (next !== "/auth/continue") {
    persistOAuthNextPath(next);
  } else {
    try {
      sessionStorage.removeItem(OAUTH_NEXT_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    clearClientCookie(OAUTH_NEXT_COOKIE);
  }

  if (intent) {
    writeClientCookie(OAUTH_INTENT_COOKIE, intent);
    try {
      sessionStorage.setItem(OAUTH_INTENT_STORAGE_KEY, intent);
    } catch {
      /* ignore */
    }
  }

  writeClientCookie(OAUTH_SURFACE_COOKIE, surface);
  try {
    sessionStorage.setItem(OAUTH_SURFACE_STORAGE_KEY, surface);
  } catch {
    /* ignore */
  }
}

export function readOAuthNextPathFromStorage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(OAUTH_NEXT_STORAGE_KEY);
    if (!raw) return null;
    const decoded = decodeStoredPath(raw);
    if (decoded?.startsWith("/")) return decoded;
    // Fall back to treating raw as an already-plain path (value written by a
    // pre-encoding bundle version during a deploy transition).
    return raw.startsWith("/") ? raw : null;
  } catch {
    return null;
  }
}

export function readOAuthIntentFromStorage(): OAuthSignInIntent | null {
  if (typeof window === "undefined") return null;
  try {
    return parseOAuthSignInIntent(sessionStorage.getItem(OAUTH_INTENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function readOAuthSurfaceFromStorage(): OAuthSurface | null {
  if (typeof window === "undefined") return null;
  try {
    return parseOAuthSurface(sessionStorage.getItem(OAUTH_SURFACE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearOAuthNextPathStorage(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(OAUTH_NEXT_STORAGE_KEY);
    sessionStorage.removeItem(OAUTH_INTENT_STORAGE_KEY);
    sessionStorage.removeItem(OAUTH_SURFACE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  clearClientCookie(OAUTH_NEXT_COOKIE);
  clearClientCookie(OAUTH_INTENT_COOKIE);
  clearClientCookie(OAUTH_SURFACE_COOKIE);
}

export function readOAuthNextPathFromRequest(request: NextRequest): string | null {
  const fromQuery = request.nextUrl.searchParams.get("next");
  if (fromQuery?.startsWith("/")) return normalizePostAuthPath(fromQuery);

  const raw = request.cookies.get(OAUTH_NEXT_COOKIE)?.value;
  if (!raw) return null;
  try {
    // NextRequest already decodes cookie values. Decoding twice corrupts an
    // encoded nested `next` query and loses listing selections.
    const decoded = raw.startsWith("/") ? raw : decodeURIComponent(raw);
    return decoded.startsWith("/") ? normalizePostAuthPath(decoded) : null;
  } catch {
    return null;
  }
}

export function readOAuthIntentFromRequest(request: NextRequest): OAuthSignInIntent | null {
  const fromQuery = parseOAuthSignInIntent(request.nextUrl.searchParams.get("oauth_intent"));
  if (fromQuery) return fromQuery;

  const raw = request.cookies.get(OAUTH_INTENT_COOKIE)?.value;
  if (!raw) return null;
  try {
    return parseOAuthSignInIntent(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export function readOAuthSurfaceFromRequest(request: NextRequest): OAuthSurface | null {
  const fromQuery = parseOAuthSurface(request.nextUrl.searchParams.get("oauth_surface"));
  if (fromQuery) return fromQuery;

  const raw = request.cookies.get(OAUTH_SURFACE_COOKIE)?.value;
  if (!raw) return null;
  try {
    return parseOAuthSurface(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export function clearOAuthNextCookie(response: NextResponse): void {
  response.cookies.set(OAUTH_NEXT_COOKIE, "", { path: "/", maxAge: 0 });
  response.cookies.set(OAUTH_INTENT_COOKIE, "", { path: "/", maxAge: 0 });
  response.cookies.set(OAUTH_SURFACE_COOKIE, "", { path: "/", maxAge: 0 });
}
