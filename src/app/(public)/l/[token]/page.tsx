import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LinkCodeGate, LinkExpiredView, LinkMessageView, RentLinkCard } from "@/components/public/phone-bound-link-ui";
import { resolveLinkDestination } from "@/lib/one-number/link-destinations.server";
import {
  linkSessionCookieName,
  markPhoneBoundLinkUsed,
  resolvePhoneBoundLink,
  verifyLinkSession,
} from "@/lib/one-number/links.server";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// A phone-bound link is a bearer link: never indexed, and the token never leaves in a Referer.
export const metadata: Metadata = {
  title: "PropLane",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * `/l/<token>`. Unknown, malformed, expired, revoked and used links all render the same "This link
 * has expired" view. A link with a code step shows only the "Text me a code" gate until a verified
 * session exists on THIS link; nothing about its target is read before then.
 */
export default async function PhoneBoundLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const db = createSupabaseServiceRoleClient();

  const resolved = await resolvePhoneBoundLink(db, token);
  if (!resolved) return <LinkExpiredView />;
  const { link } = resolved;

  if (link.requiresOtp) {
    const jar = await cookies();
    const verified = await verifyLinkSession(db, link, jar.get(linkSessionCookieName(token))?.value);
    if (!verified) return <LinkCodeGate token={token} />;
  }

  const destination = await resolveLinkDestination(db, link);
  switch (destination.kind) {
    case "redirect":
      redirect(destination.href);
    case "portal": {
      // Already signed in as the resident this link is for (the code step opened that session): go straight
      // there. Anyone else, or no session, goes through sign-in as before.
      if (destination.directHref && destination.signedInAs) {
        const signedIn = await createRealIdentitySupabaseServerClient()
          .then((client) => client.auth.getUser())
          .then((result) => result.data.user?.id ?? null)
          .catch(() => null);
        if (signedIn === destination.signedInAs) redirect(destination.directHref);
      }
      redirect(destination.href);
    }
    case "rent":
      // Back from Stripe: show the outcome, not the Pay button, while the webhook settles the charge.
      if (query.ach_checkout === "success") return <LinkMessageView title="Payment received" line="You can close this page." />;
      return <RentLinkCard token={token} charges={destination.charges} />;
    case "paid":
      await markPhoneBoundLinkUsed(db, link.id);
      return <LinkMessageView title="Payment received" line="You can close this page." />;
    // A bank debit that has not settled is not a receipt, and the link stays live: if the debit fails the charge
    // is payable again and this is the only link the resident has.
    case "processing":
      return <LinkMessageView title="Payment processing" line="Your bank transfer is still clearing. We will text you when it settles." />;
    case "phone_changed":
      return <LinkMessageView title="This link is for a different number" line="Text us for a new link." />;
    default:
      return <LinkExpiredView />;
  }
}
