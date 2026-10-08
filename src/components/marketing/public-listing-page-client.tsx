"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { ListedWithProPlaneBand } from "@/components/marketing/listed-with-proplane-band";
import { getListingRichContent } from "@/data/listing-rich-content";
import { loadPublicPropertyLeadFromServer, PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import { getPropertyForPublicLink } from "@/lib/rental-application/data";
import { useProspectListingHrefs } from "@/hooks/use-prospect-listing-hrefs";

export function PublicListingPageClient() {
  const params = useParams();
  const listingId = typeof params.id === "string" ? params.id.trim() : "";
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!listingId) {
      queueMicrotask(() => {
        setLoading(false);
        setLoadFailed(true);
      });
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      setLoading(true);
      setLoadFailed(false);
    });
    void loadPublicPropertyLeadFromServer(listingId)
      .then((property) => {
        if (cancelled) return;
        setLoadFailed(!property);
        setTick((n) => n + 1);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const on = () => setTick((n) => n + 1);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => {
      cancelled = true;
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
    };
  }, [listingId]);

  const property = useMemo(() => {
    void tick;
    if (!listingId) return undefined;
    return getPropertyForPublicLink(listingId);
  }, [listingId, tick]);

  const rich = useMemo(() => (property ? getListingRichContent(property) : null), [property]);
  const { applyHref } = useProspectListingHrefs(listingId);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <p className="text-sm text-muted">Loading listing…</p>
      </div>
    );
  }

  if (!property || !rich || loadFailed) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center px-4 py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Listing not found</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          This property may be unlisted or the link may be outdated. Ask your property manager for an updated link, or
          browse available homes on PropLane.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-accent/30"
          >
            Go home
          </Link>
          {listingId ? (
            <Link
              href={applyHref}
              className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Try apply link
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <ListingDetailSections property={property} rich={rich} expandSectionsOnMobile />
      {property.showProPlaneAttribution ? <ListedWithProPlaneBand propertyId={property.id} /> : null}
    </>
  );
}
