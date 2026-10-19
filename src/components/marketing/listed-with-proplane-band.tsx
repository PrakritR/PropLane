"use client";

import Link from "next/link";

import { AxisLogoGlyph } from "@/components/brand/axis-logo";
import { track } from "@/lib/analytics/track-client";
import { LISTING_ATTRIBUTION_PARTNER_PATH } from "@/lib/listing-attribution";

/**
 * Bottom band of the public listing page: the PropLane mark and "Listed with PropLane" on the
 * left, one link to the landlord page on the right. The page decides whether to draw it
 * (`property.showProPlaneAttribution`, resolved server-side); this component only draws.
 */
export function ListedWithProPlaneBand({ propertyId }: { propertyId: string }) {
  return (
    <div className="ps border-t border-[var(--ps-ink)] bg-[var(--ps-paper)]" data-attr="listed-with-proplane-band">
      <div className="ps-wrap flex min-h-14 items-center justify-between gap-4 py-3">
        <span className="flex min-w-0 items-center gap-2.5 text-sm font-medium">
          <AxisLogoGlyph size="compact" />
          <span className="truncate">Listed with PropLane</span>
        </span>
        <Link
          href={LISTING_ATTRIBUTION_PARTNER_PATH}
          data-attr="listed-with-proplane-cta"
          className="ps-link shrink-0 whitespace-nowrap text-sm"
          onClick={() => track("landlord_cta_clicked", { source: "listing_page", listing_id: propertyId })}
        >
          Free for landlords →
        </Link>
      </div>
    </div>
  );
}
