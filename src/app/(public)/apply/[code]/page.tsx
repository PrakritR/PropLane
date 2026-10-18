import type { Metadata } from "next";
import { LinkExpiredView, PublicPhoneBindForm } from "@/components/public/phone-bound-link-ui";
import { lookupEntryCode } from "@/lib/one-number/public-bind.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PropLane", robots: { index: false, follow: false } };

/**
 * `/apply/<code>`: a public door keyed on an entry code. It asks for a phone, texts a code to it,
 * and binds that phone to a link. An unknown or inactive code renders the same expired view.
 */
export default async function PublicBindApplyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const entry = await lookupEntryCode(createSupabaseServiceRoleClient(), code);
  if (!entry) return <LinkExpiredView />;
  return <PublicPhoneBindForm code={entry.code} kind="apply" heading="Apply" />;
}
