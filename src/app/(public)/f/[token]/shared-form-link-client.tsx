"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { linkedFormSharePath } from "@/lib/linked-form-path";
import { redeemLinkedFormLink } from "@/lib/linked-form-requests-client";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Phase = "checking" | "signin" | "refused";

/**
 * What a form share link opens. It needs a resident account: a visitor without one signs in or creates one and
 * is brought straight back. Redeeming (which links their account to the applicant for this one form) happens
 * only once they are signed in, and every link that cannot be used reads the same, so the page is never a way to
 * find out whether an application or a link exists.
 */
export default function SharedFormLinkClient({ token }: { token: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");
  const here = linkedFormSharePath(token);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let signedIn = false;
      try {
        const {
          data: { session },
        } = await createSupabaseBrowserClient().auth.getSession();
        signedIn = Boolean(session);
      } catch {
        signedIn = false;
      }
      if (cancelled) return;
      if (!signedIn) {
        setPhase("signin");
        return;
      }
      const outcome = await redeemLinkedFormLink(token);
      if (cancelled) return;
      if (outcome.kind === "ok") {
        router.replace(outcome.path);
        return;
      }
      setPhase(outcome.kind === "signin" ? "signin" : "refused");
    })();
    return () => {
      cancelled = true;
    };
  }, [token, router]);

  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center" data-attr="shared-form-link">
      {phase === "checking" ? (
        <p className="text-sm text-muted" role="status">
          Opening…
        </p>
      ) : null}
      {phase === "signin" ? (
        <>
          <h1 className="text-xl font-bold text-foreground">Open this form</h1>
          <div className="mt-6 flex flex-col gap-3">
            <Button asChild data-attr="shared-form-sign-in">
              <Link href={`/auth/sign-in?intent=resident&next=${encodeURIComponent(here)}`}>Sign in</Link>
            </Button>
            <Button asChild variant="outline" data-attr="shared-form-create-account">
              <Link href={`/auth/create-account?mode=create&role=resident&next=${encodeURIComponent(here)}`}>
                Create a resident account
              </Link>
            </Button>
          </div>
        </>
      ) : null}
      {phase === "refused" ? (
        <>
          <h1 className="text-xl font-bold text-foreground">This link can&apos;t be used</h1>
          <div className="mt-6">
            <Button asChild variant="outline">
              <Link href="/">Back to PropLane</Link>
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
