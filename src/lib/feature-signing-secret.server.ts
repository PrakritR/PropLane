import "server-only";

/**
 * The HMAC key for a self-contained, feature-scoped token (no generic app-wide
 * signing key exists in this repo - see `rate-limit.ts` and
 * `mcp/oauth.server.ts`): the service role key every real deployment already
 * requires for the service-role client these modules run under.
 *
 * It FAILS CLOSED. A literal fallback ("test-only-…") is a published secret:
 * any deployment that lost `SUPABASE_SERVICE_ROLE_KEY` would start accepting -
 * and minting - tokens anybody reading this source could forge. Only the test
 * runner gets a deterministic stand-in, and it is derived per feature so two
 * features never share one key.
 */
export function featureSigningSecret(feature: string): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (key) return key;
  if (process.env.NODE_ENV === "test") return `test-only-${feature}-secret`;
  throw new Error("Server misconfigured: SUPABASE_SERVICE_ROLE_KEY is required to sign this token.");
}
