"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import "@/components/public-site/listing-gallery.css";
import { ListedWithProPlaneBand } from "@/components/marketing/listed-with-proplane-band";
import { getListingRichContent } from "@/data/listing-rich-content";
import { loadPublicPropertyLeadFromServer, PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import { getPropertyForPublicLink } from "@/lib/rental-application/data";

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

  if (loading) {
    return (
      <div className="ps ps-ld @container" aria-busy="true" aria-label="Loading listing" data-attr="listing-loading">
        <div className="ps-wrap ps-ld-in">
          <div className="ps-sk" style={{ aspectRatio: "16 / 10", maxHeight: 520, width: "100%" }} />
          <div className="ps-sk" style={{ height: 44, width: "min(520px, 80%)", marginTop: 28 }} />
          <div className="ps-sk" style={{ height: 18, width: "min(280px, 50%)", marginTop: 14 }} />
          <div className="ps-sk" style={{ height: 40, width: 180, marginTop: 24 }} />
          <div className="grid gap-10 @min-[900px]:grid-cols-[minmax(0,1fr)_320px]" style={{ marginTop: 40 }}>
            <div className="grid gap-4">
              <div className="ps-sk" style={{ height: 72 }} />
              <div className="ps-sk" style={{ height: 72 }} />
              <div className="ps-sk" style={{ height: 72 }} />
            </div>
            <div className="ps-sk hidden @min-[900px]:block" style={{ height: 280 }} />
          </div>
        </div>
      </div>
    );
  }

  if (!property || !rich || loadFailed) {
    return (
      <div className="ps ps-ld">
        <div className="ps-wrap ps-nf" data-attr="listing-not-found">
          <h1 className="ps-h2">Listing not found</h1>
          <p className="m-0 max-w-[46ch]">This home may be unlisted, or the link is out of date.</p>
          <div className="ps-nf-acts">
            <Link href="/rent/browse" className="ps-btn ps-btn-blue">
              Find a home
            </Link>
            <Link href="/" className="ps-btn ps-btn-line">
              Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <ListingDetailSections property={property} rich={rich} expandSectionsOnMobile phoneDock />
      {property.showProPlaneAttribution ? <ListedWithProPlaneBand propertyId={property.id} /> : null}
    </>
  );
}
