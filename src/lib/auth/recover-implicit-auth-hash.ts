import type { SupabaseClient } from "@supabase/supabase-js";

function parseHashParams(hash: string): URLSearchParams {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(trimmed);
}

/**
 * Supabase hosted verify links (magic link, some legacy flows) redirect with session
 * tokens in the URL hash. The server `/auth/callback` route only handles PKCE `code`
 * query params, so those land on sign-in with a scary OAuth error and tokens in the
 * fragment. Recover the session client-side when present.
 */
export async function recoverImplicitAuthHash(
  supabase: SupabaseClient,
): Promise<{ recovered: boolean; type: string | null }> {
  if (typeof window === "undefined") return { recovered: false, type: null };
  const hash = window.location.hash;
  if (!hash || !hash.includes("access_token=")) return { recovered: false, type: null };

  const params = parseHashParams(hash);
  const accessToken = params.get("access_token")?.trim() ?? "";
  const refreshToken = params.get("refresh_token")?.trim() ?? "";
  const type = params.get("type")?.trim() ?? null;
  if (!accessToken || !refreshToken) return { recovered: false, type };

  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) return { recovered: false, type };

  const cleanUrl = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(null, "", cleanUrl);
  return { recovered: true, type };
}
