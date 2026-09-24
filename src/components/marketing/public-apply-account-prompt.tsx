"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  publicApplyCreateAccountHref,
  publicApplySignInHref,
} from "@/lib/rental-application/public-apply-session";

/**
 * Shown before the public rental wizard when the applicant is not signed in.
 * A resident account is required to apply (PLAN-0924-1421): create one, or sign
 * in if you are a returning resident. There is no guest path.
 */
export function PublicApplyAccountPrompt({
  gateKey,
  applyReturnPath,
  propertyTitle,
}: {
  gateKey: string;
  applyReturnPath: string;
  propertyTitle?: string;
}) {
  const [resolved, setResolved] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const { data } = await supabase.auth.getSession();
        if (!cancelled) {
          setSignedIn(Boolean(data.session?.user));
          setResolved(true);
        }
      } catch {
        if (!cancelled) setResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateKey]);

  if (!resolved || signedIn) return null;

  const listing = propertyTitle?.trim() || "this home";

  return (
    <div className="mx-auto w-full max-w-3xl py-2 sm:py-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">Before you apply</p>
      <h1 className="mt-2 text-lg font-bold tracking-tight text-foreground sm:text-xl">
        Create your resident account
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        A resident account is required to apply for {listing}. Create one and apply from your portal, where you track
        your application, messages, and payments. Already have an account? Sign in.
      </p>
      <div className="mt-4 flex flex-wrap gap-2.5">
        <Link
          href={publicApplyCreateAccountHref(gateKey, applyReturnPath)}
          className="btn-cobalt inline-flex min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-full px-5 text-[15px] font-semibold sm:px-6"
          data-attr="public-apply-create-account"
        >
          Create account
        </Link>
        <Link
          href={publicApplySignInHref(gateKey, applyReturnPath)}
          className="inline-flex min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-full border border-border px-5 text-[15px] font-semibold text-foreground sm:px-6"
          data-attr="public-apply-sign-in"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}
