"use client";

import { EmailFirstSignup } from "@/components/auth/email-first-signup";
import { AuthCard } from "@/components/auth/auth-card";
import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";
import { safeNextPath } from "@/lib/auth/safe-next-path";
import { useSearchParams } from "next/navigation";

/**
 * The single account-CREATION surface, reached only from /auth/create-account (role picked before
 * it, or carried on `?role=`). It is `EmailFirstSignup`: an email, an emailed `token_hash` link
 * that proves the mailbox, and only then the account details.
 *
 * The retired password form that used to live beside it — `LegacyPortalAuthForm`, which POSTed
 * `{ email, password }` to `/api/auth/signup` and then `signInWithPassword` — is deleted. It had
 * been unreachable since this export stopped branching, and `/api/auth/signup` no longer creates
 * anything: it refuses any caller that is not already a verified, signed-in mailbox owner. Keeping
 * ~345 lines of the exact flow this release retired only invited someone to wire it back up. The
 * guards that pinned its behaviour now pin the retirement itself
 * (`tests/unit/portal-auth-form-signup-timeout.test.ts`).
 */
export function PortalAuthForm() {
  const params = useSearchParams();
  if (params.get("tour_inquiry")) return <AuthCard variant="blend"><EmailFirstSignup intent="tour" tourInquiryId={params.get("tour_inquiry") ?? undefined} initialEmail={params.get("email") ?? ""} /></AuthCard>;
  const intent = params.get("role") === "resident" ? "resident" : "generic";
  let oauthNextPath: string | undefined;
  let listing: { propertyId?: string; listingRoomId?: string; bundleId?: string; applicationFormId?: string; rentalType?: string } | undefined;
  try {
    const rawNext = params.get("next") ?? "";
    const next = new URL(rawNext, "https://local.invalid");
    if (safeNextPath(rawNext) && !isUnsafeRedirectPath(rawNext) && next.origin === "https://local.invalid" && next.pathname === "/resident/applications/apply" && next.searchParams.get("propertyId")) {
      oauthNextPath = rawNext;
      listing = {
      propertyId: next.searchParams.get("propertyId") || undefined, listingRoomId: next.searchParams.get("listingRoomId") || undefined,
      bundleId: next.searchParams.get("bundle") || undefined, applicationFormId: next.searchParams.get("form") || undefined,
      rentalType: next.searchParams.get("rentalType") || undefined,
      };
    }
  } catch { /* Invalid destinations are ignored. */ }
  return <AuthCard variant="blend"><EmailFirstSignup intent={intent} listing={listing} oauthNextPath={oauthNextPath} initialEmail={params.get("email") ?? ""} /></AuthCard>;
}
