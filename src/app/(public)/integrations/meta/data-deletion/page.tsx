import type { Metadata } from "next";

import {
  MarketingHero,
  MarketingPageShell,
  MarketingSection,
} from "@/components/marketing/marketing-page-shell";
import { readDeletionConfirmationCode } from "@/lib/listing-channels/meta/data-deletion";
import { PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";

export const metadata: Metadata = {
  title: "Facebook data deletion",
  robots: { index: false, follow: false },
};

/**
 * Where Meta's data-deletion callback points a person. The confirmation code is signed with the Meta
 * app secret, so a valid code proves PropLane removed the stored Facebook connection and posting rows.
 */
export default async function MetaDataDeletionPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const secret = process.env.META_APP_SECRET?.trim() ?? "";
  const confirmed = readDeletionConfirmationCode(code, secret);

  return (
    <MarketingPageShell>
      <MarketingHero title="Facebook data deletion" />
      <MarketingSection narrow>
        {confirmed ? (
          <p data-attr="meta-data-deletion-confirmed">
            Your request was processed on {new Date(confirmed.deletedAt).toUTCString()}. PropLane deleted the stored
            Facebook connection and the record of what it posted to Facebook and Instagram. Posts already on
            Facebook stay on Facebook until you remove them there.
          </p>
        ) : (
          <p data-attr="meta-data-deletion-instructions">
            To remove PropLane&apos;s access to your Facebook Page, open Settings, Integrations, Posting in PropLane
            and disconnect Facebook, or remove PropLane under Settings, Business Integrations on Facebook. Either
            deletes the stored connection. To ask us to delete the rest, email {PUBLIC_SUPPORT_EMAIL}.
          </p>
        )}
      </MarketingSection>
    </MarketingPageShell>
  );
}
