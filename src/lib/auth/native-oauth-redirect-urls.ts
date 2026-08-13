import { NATIVE_OAUTH_CALLBACK_URL, NATIVE_OAUTH_SCHEME, nativeOAuthCallbackUrl } from "@/lib/auth/native-oauth-callback";
import { partnerPricingOAuthCallbackUrl, residentSignupOAuthCallbackUrl, vendorSignupOAuthCallbackUrl } from "@/lib/auth/oauth-redirect";
import { knownProductionWebOrigins, resolveShareableAppOrigin } from "@/lib/app-url";

/** Custom-scheme callbacks Supabase Auth must allowlist for the native shell. */
export function nativeSupabaseRedirectUrls(): string[] {
  return [
    NATIVE_OAUTH_CALLBACK_URL,
    nativeOAuthCallbackUrl("/auth/callback/partner-pricing"),
    nativeOAuthCallbackUrl("/auth/callback/resident-signup"),
    nativeOAuthCallbackUrl("/auth/callback/vendor-signup"),
    // Wildcard covers any future fixed callback paths under auth/callback/*
    `${NATIVE_OAUTH_SCHEME}://auth/callback/**`,
  ];
}

/** HTTPS callbacks used when universal/app links return OAuth to the main WebView. */
export function httpsOAuthCallbackUrls(origin?: string): string[] {
  const bases = new Set<string>();
  const seed = (origin ?? resolveShareableAppOrigin()).trim().replace(/\/$/, "");
  if (seed) bases.add(seed);
  for (const productionOrigin of knownProductionWebOrigins()) {
    bases.add(productionOrigin.replace(/\/$/, ""));
  }
  const urls: string[] = [];
  for (const base of bases) {
    urls.push(
      `${base}/auth/callback`,
      partnerPricingOAuthCallbackUrl(base),
      residentSignupOAuthCallbackUrl(base),
      vendorSignupOAuthCallbackUrl(base),
    );
  }
  return urls;
}

export function nativeOAuthSetupHint(): string {
  const https = httpsOAuthCallbackUrls()[0];
  const native = nativeSupabaseRedirectUrls()[0];
  return (
    `In Supabase → Authentication → URL configuration → Redirect URLs, add ${native} ` +
    `(required for iOS — ASWebAuthenticationSession returns through the app scheme) and ` +
    `${https} (required for Android, which returns through the HTTPS bridge). ` +
    `If the scheme entry is missing, Supabase drops redirect_to to the Site URL and sign-in ` +
    `opens the marketing homepage instead of returning to the app.`
  );
}
