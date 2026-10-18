import type { Metadata } from "next";
import { LinkExpiredView } from "@/components/public/phone-bound-link-ui";
import { FinishSetupCard } from "@/components/public/finish-setup-card";
import { resolveSetupLink } from "@/lib/one-number/onboarding/setup-links.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// A setup link is a bearer link: never indexed, and the token never leaves in a Referer.
export const metadata: Metadata = {
  title: "PropLane",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** `/start/<token>`: finish setup after the demo or the vendor intake. Dead, unknown and used links read the same. */
export default async function FinishSetupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await resolveSetupLink(createSupabaseServiceRoleClient(), token);
  if (!link) return <LinkExpiredView />;
  const digits = link.phoneKey ?? "";
  const lastFour = digits.length >= 4 ? digits.slice(-4) : null;
  return <FinishSetupCard token={token} kind={link.kind} boundPhoneLastFour={lastFour} />;
}
