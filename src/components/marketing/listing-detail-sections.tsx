"use client";

import Link from "next/link";
import Image from "next/image";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  ListingDetailCollapsibleSection,
  ListingDetailCollapsibleSimpleSection,
} from "@/components/marketing/listing-detail-collapsible-section";
import { ListingStickySubnav } from "@/components/marketing/listing-detail-subnav";
import { ListingLocationBlock } from "@/components/marketing/listing-location-block";
import {
  AmenitiesTableInteractive,
  BundleTableInteractive,
  LeaseBasicsTableInteractive,
  ListingDetailModal,
} from "@/components/marketing/listing-detail-tables-client";
import { ListingBathroomMediaBrowser, ListingSharedMediaBrowser } from "@/components/marketing/listing-amenity-media-browsers";
import { ListingRoomMediaBrowser } from "@/components/marketing/listing-room-media-browser";
import { compareListingRoomMediaEntries } from "@/lib/listing-floor-order";
import {
  ListingPreviewNewTabContext,
  ListingSidebarRenterCtasContext,
} from "@/components/marketing/listing-preview-context";
import { buildSmsDeepLink, isClawMessagingPubliclyEnabled } from "@/lib/claw-leasing-links";
import { ProspectListingCta } from "@/components/marketing/prospect-listing-cta";
import type { MockProperty } from "@/data/types";
import { DEFAULT_LISTING_HOUSE_RULES_FALLBACK, type ListingRichContent } from "@/data/listing-rich-content";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";

function filterSidebarQuickFacts(
  facts: { label: string; value: string }[],
  property: MockProperty,
): { label: string; value: string }[] {
  const title = property.title?.trim().toLowerCase() ?? "";
  const skip = new Set(["Neighborhood", "Overview", "Bedrooms"]);
  return facts.filter((q) => {
    const label = q.label.trim();
    const value = q.value.trim();
    if (!value || value === "—" || skip.has(label)) return false;
    if (label === "Building" && value.toLowerCase() === title) return false;
    return true;
  });
}

const listingSectionScroll =
  "scroll-mt-[var(--listing-sticky-stack,calc(env(safe-area-inset-top,0px)+9.5rem))]";

function ListingSubsection({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <div id={id} className={`${id ? listingSectionScroll : ""} border-t border-border/60 pt-8 first:border-0 first:pt-0`}>
      <h3 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">{title}</h3>
      <div className="mt-4 md:overflow-x-auto">{children}</div>
    </div>
  );
}

function ListingHeroPhotoGrid({
  urls,
  priceRangeLabel,
}: {
  urls: string[];
  priceRangeLabel: string;
}) {
  const [slide, setSlide] = useState(0);
  const n = urls.length;

  const mainUrl = n ? urls[slide % n]! : null;
  const side1 = n > 1 ? urls[1]! : null;
  const side2 = n > 2 ? urls[2]! : null;

  const go = (delta: number) => {
    if (n <= 1) return;
    setSlide((s) => (s + delta + n) % n);
  };

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="relative min-w-0 overflow-hidden rounded-3xl border border-border bg-accent/25 shadow-sm">
        {mainUrl ? (
          <Image src={mainUrl} alt="" fill className="object-cover" unoptimized sizes="(max-width: 1024px) 100vw, 60vw" />
        ) : (
          <NoImagePlaceholder />
        )}
        {n > 0 ? (
          <div className="absolute right-3 top-3 rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm sm:right-4 sm:top-4 sm:px-3 sm:text-xs">
            {n > 1 ? `${slide + 1} / ${n}` : "1 / 1"}
          </div>
        ) : (
          <div className="absolute right-3 top-3 rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm sm:right-4 sm:top-4 sm:px-3 sm:text-xs">
            Gallery
          </div>
        )}
        <div className="listing-photo-chip absolute bottom-3 right-3 max-w-[min(100%,14rem)] truncate rounded-full bg-card px-3 py-1.5 text-xs font-bold text-foreground shadow-md backdrop-blur-sm sm:bottom-4 sm:right-4 sm:max-w-none sm:px-4 sm:py-2 sm:text-sm">
          {priceRangeLabel}
        </div>
        <div className="aspect-[4/3] w-full" />
        {n > 1 ? (
          <>
            <button
              type="button"
              aria-label="Previous photo"
              className="listing-photo-chip absolute left-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-card shadow-md transition hover:bg-card"
              onClick={() => go(-1)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Next photo"
              className="listing-photo-chip absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-card shadow-md transition hover:bg-card"
              onClick={() => go(1)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        ) : null}
      </div>
      <div className="grid grid-rows-2 gap-4">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-accent/30 shadow-sm">
          {side1 ? (
            <Image src={side1} alt="" fill className="object-cover" unoptimized sizes="(max-width: 1024px) 40vw" />
          ) : n === 0 ? (
            <NoImagePlaceholder />
          ) : null}
          <div className="aspect-[16/10] h-full min-h-[120px] w-full lg:aspect-auto lg:min-h-0" />
        </div>
        <div className="relative overflow-hidden rounded-3xl border border-border bg-accent/30 shadow-sm">
          {side2 ? (
            <Image src={side2} alt="" fill className="object-cover" unoptimized sizes="(max-width: 1024px) 40vw" />
          ) : n === 0 ? (
            <NoImagePlaceholder />
          ) : null}
          <div className="aspect-[16/10] h-full min-h-[120px] w-full lg:aspect-auto lg:min-h-0" />
        </div>
      </div>
    </div>
  );
}

function formatBoldSegments(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

const primaryCtaClass =
  "btn-cobalt flex w-full items-center justify-center rounded-full py-3 text-sm font-semibold outline-none transition hover:-translate-y-[1px] active:translate-y-0";
const secondaryCtaClass =
  "btn-metallic mt-3 flex min-h-[48px] w-full items-center justify-center rounded-full py-3 text-sm font-semibold text-foreground outline-none transition hover:-translate-y-[1px] active:translate-y-0";

function ListingPricingCtaCard({
  property,
  rich,
  className = "",
}: {
  property: MockProperty;
  rich: ListingRichContent;
  className?: string;
}) {
  const primaryPrice = rich.estimatedMonthlyTotalLabel ?? rich.startingRentLabel;
  const showsEstimatedTotal = Boolean(rich.estimatedMonthlyTotalLabel);
  const propertyLabel = property.buildingName?.trim() || property.title?.trim() || property.address?.trim() || null;
  const textEnabled = isClawMessagingPubliclyEnabled(property.contactSmsPhone);
  const textTourHref = textEnabled
    ? buildSmsDeepLink({
        intent: "tour",
        propertyId: property.id,
        propertyLabel,
        toPhone: property.contactSmsPhone,
      })
    : null;
  const textApplyHref = textEnabled
    ? buildSmsDeepLink({
        intent: "apply",
        propertyId: property.id,
        propertyLabel,
        toPhone: property.contactSmsPhone,
      })
    : null;

  return (
    <Card className={`overflow-hidden border-border bg-card p-0 shadow-sm backdrop-blur-xl ${className}`}>
      <div className="border-b border-border/60 bg-gradient-to-br from-primary/8 via-transparent to-transparent px-5 py-5 sm:px-6 sm:py-6">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
          {showsEstimatedTotal ? "Estimated monthly from" : "Base rent from"}
        </p>
        <p className="mt-1 text-3xl font-bold tracking-tight text-primary sm:text-4xl">{primaryPrice}</p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {showsEstimatedTotal
            ? `Rent + utilities estimate. Base rent ${rich.startingRentLabel}.`
            : "Before utilities and other fees."}
        </p>
        {rich.pricingBreakdown && rich.pricingBreakdown.length > 0 ? (
          <ul className="mt-4 divide-y divide-border/50 border-t border-border/60 pt-3 text-sm">
            {rich.pricingBreakdown.map((line) => (
              <li key={line.label} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <span className="text-muted">{line.label}</span>
                <span className="shrink-0 font-semibold text-foreground">{line.value}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
        {textTourHref ? (
          <a href={textTourHref} data-attr="listing-text-tour" className={`${primaryCtaClass} min-h-[48px] mt-0`}>
            Text to tour
          </a>
        ) : (
          <ProspectListingCta
            action="tour"
            propertyId={property.id}
            data-attr="listing-web-tour"
            className={`${primaryCtaClass} min-h-[48px] mt-0`}
          >
            Schedule a tour
          </ProspectListingCta>
        )}
        {textApplyHref ? (
          <a href={textApplyHref} data-attr="listing-text-apply" className={secondaryCtaClass}>
            Text to apply
          </a>
        ) : (
          <ProspectListingCta
            action="apply"
            propertyId={property.id}
            data-attr="listing-web-apply"
            className={secondaryCtaClass}
          >
            Apply online
          </ProspectListingCta>
        )}
        {textTourHref || textApplyHref ? (
          <p className="mt-3 text-center text-xs text-muted">
            No texting on this device?{" "}
            <ProspectListingCta action="tour" propertyId={property.id} className="underline underline-offset-2" data-attr="listing-web-tour-fallback">
              Schedule a tour
            </ProspectListingCta>{" "}
            or{" "}
            <ProspectListingCta action="apply" propertyId={property.id} className="underline underline-offset-2" data-attr="listing-web-apply-fallback">
              apply online
            </ProspectListingCta>
            .
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function Sidebar({
  property,
  rich,
  className = "",
}: {
  property: MockProperty;
  rich: ListingRichContent;
  className?: string;
}) {
  const sidebarFacts = filterSidebarQuickFacts(rich.quickFacts, property);
  return (
    <aside
      className={`order-2 space-y-5 lg:sticky lg:top-[var(--listing-sticky-stack,calc(env(safe-area-inset-top,0px)+7.5rem))] lg:self-start ${className}`}
    >
      <ListingPricingCtaCard property={property} rich={rich} className="hidden lg:block" />
      {sidebarFacts.length > 0 ? (
        <Card className="hidden border-border bg-card p-5 shadow-sm backdrop-blur-xl sm:p-6 md:block [html[data-native]_&]:!hidden">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted">At a glance</p>
          <ul className="mt-3 divide-y divide-border/50 text-sm">
            {sidebarFacts.map((q) => (
              <li key={q.label} className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <span className="shrink-0 text-xs font-medium text-muted">{q.label}</span>
                <span className="font-semibold leading-snug text-foreground sm:text-right">{q.value}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </aside>
  );
}

function FloorPlansSectionBody({
  property,
  rich,
  propertyLabel,
}: {
  property: MockProperty;
  rich: ListingRichContent;
  propertyLabel: string | null;
}) {
  const [detailModal, setDetailModal] = useState<
    | {
        kind: "room";
        room: (typeof rich.floorPlans)[number]["rooms"][number];
        floorLabel: string;
      }
    | { kind: "bathroom"; row: (typeof rich.bathrooms)[number] }
    | { kind: "shared"; row: (typeof rich.sharedSpaces)[number] }
    | null
  >(null);

  const mediaEntries = useMemo(
    () =>
      rich.floorPlans
        .flatMap((f) =>
          f.rooms.map((room) => ({
            room,
            floorLabel: f.floorLabel,
          })),
        )
        .sort(compareListingRoomMediaEntries),
    [rich.floorPlans],
  );

  return (
    <>
      {mediaEntries.length > 0 ? (
        <ListingRoomMediaBrowser
          entries={mediaEntries}
          listingPropertyId={property.id}
          propertyLabel={propertyLabel}
          contactSmsPhone={property.contactSmsPhone}
          onOpenDetails={(entry) =>
            setDetailModal({ kind: "room", room: entry.room, floorLabel: entry.floorLabel })
          }
          className="mb-4"
        />
      ) : null}
      <ListingDetailModal
        state={detailModal}
        onClose={() => setDetailModal(null)}
        listingPropertyId={property.id}
        propertyLabel={propertyLabel}
        contactSmsPhone={property.contactSmsPhone}
      />
      {rich.bathrooms.length > 0 ? (
        <ListingSubsection title="Bathrooms">
          <ListingBathroomMediaBrowser
            rows={rich.bathrooms}
            listingPropertyId={property.id}
            propertyLabel={propertyLabel}
            contactSmsPhone={property.contactSmsPhone}
            onOpenDetails={(row) => setDetailModal({ kind: "bathroom", row })}
          />
        </ListingSubsection>
      ) : null}
      {rich.sharedSpaces.length > 0 ? (
        <ListingSubsection title="Shared spaces" id="listing-shared">
          <ListingSharedMediaBrowser
            rows={rich.sharedSpaces}
            listingPropertyId={property.id}
            propertyLabel={propertyLabel}
            contactSmsPhone={property.contactSmsPhone}
            onOpenDetails={(row) => setDetailModal({ kind: "shared", row })}
          />
        </ListingSubsection>
      ) : null}
    </>
  );
}

export function ListingDetailSections({
  property,
  rich,
  previewModal = false,
  hidePreviewSubnav = false,
  /** Manager property preview — scrolls inside #portal-main-content with a sticky section subnav. */
  portalEmbedded = false,
  /** Manager property preview — show full section bodies on mobile (no View pill). */
  expandSectionsOnMobile = false,
  /** Tighter portal chrome inside manager property preview tab. */
  managerPreviewChrome = false,
  /** Parent renders listing section tabs in property detail chrome (manager preview). */
  hidePortalSubnav = false,
}: {
  property: MockProperty;
  rich: ListingRichContent;
  /** When true (public preview dialog), section tabs sit at the top and stick within the modal scroller. */
  previewModal?: boolean;
  /** When true, parent renders pinned preview subnav outside the scroller (manager property tab). */
  hidePreviewSubnav?: boolean;
  portalEmbedded?: boolean;
  expandSectionsOnMobile?: boolean;
  managerPreviewChrome?: boolean;
  hidePortalSubnav?: boolean;
}) {
  const roomCount = rich.floorPlans.reduce((n, f) => n + f.rooms.length, 0);
  const collapseOnMobile = !expandSectionsOnMobile;
  const compactSections = managerPreviewChrome;
  const embeddedPreview = previewModal || portalEmbedded;
  const houseRulesDisplay =
    rich.houseRulesBody?.trim() ||
    (!property.listingSubmission ? DEFAULT_LISTING_HOUSE_RULES_FALLBACK : null);
  const heroUrls = rich.heroHousePhotoUrls ?? [];
  const propertyLabel = property.buildingName?.trim() || property.title?.trim() || property.address?.trim() || null;
  return (
    <ListingPreviewNewTabContext.Provider value={embeddedPreview}>
    <ListingSidebarRenterCtasContext.Provider value={!embeddedPreview}>
    <div className="bg-background text-foreground min-w-0 max-w-full" data-listing-sections-root>
      <div
        className={`mx-auto flex min-w-0 max-w-6xl flex-col ${
          managerPreviewChrome ? "px-3 sm:px-4" : "px-4"
        } ${
          embeddedPreview
            ? managerPreviewChrome
              ? "pb-6 pt-0 sm:pb-8"
              : "pb-8 pt-2 sm:pb-10 sm:pt-3"
            : "py-8 sm:py-10 [html[data-native]_&]:pb-[max(2rem,env(safe-area-inset-bottom))] [html[data-native]_&]:pt-[max(0.5rem,env(safe-area-inset-top))]"
        }`}
      >
        {previewModal && !hidePreviewSubnav ? (
          <ListingStickySubnav mode="modal" />
        ) : embeddedPreview || managerPreviewChrome ? null : (
          <Link
            href="/rent/browse"
            data-attr="listing-detail-back"
            className="order-1 mb-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:opacity-90 lg:mb-5"
          >
            ← Back to homes
          </Link>
        )}

        <div className="order-2">
          <ListingHeroPhotoGrid key={heroUrls.join("|")} urls={heroUrls} priceRangeLabel={rich.priceRangeLabel} />
        </div>

        {!(embeddedPreview && expandSectionsOnMobile) ? (
        <div className="order-3 mt-6 flex flex-col gap-4 lg:mt-8">
          <div className="max-w-3xl">
            <Badge tone="info">{property.neighborhood}</Badge>
            <h1 className="mt-3 text-2xl font-bold tracking-tight text-foreground sm:text-3xl md:text-[2.125rem] md:leading-tight">
              {property.title}
            </h1>
            <p className="mt-2 text-sm text-muted sm:text-base">{property.address}</p>
            {rich.heroTagline ? (
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted sm:text-[0.9375rem]">
                {rich.heroTagline}
              </p>
            ) : null}
            {rich.heroOverview ? (
              <p className="mt-3 max-w-2xl whitespace-pre-wrap text-sm leading-relaxed text-foreground/85 sm:text-[0.9375rem]">
                {formatBoldSegments(rich.heroOverview)}
              </p>
            ) : null}
          </div>
        </div>
        ) : null}

        <div className={`order-4 ${embeddedPreview ? (managerPreviewChrome ? "mt-0" : "mt-6") : "mt-6 lg:mt-8"}`}>
          {portalEmbedded ? (
            hidePortalSubnav ? null : (
              <ListingStickySubnav
                mode="portal"
                appearance="portal"
                className="mb-4 sm:rounded-2xl lg:mb-6"
              />
            )
          ) : !previewModal ? (
            <ListingStickySubnav className="mb-4 lg:mb-6" />
          ) : null}
          {!embeddedPreview ? (
            <ListingPricingCtaCard property={property} rich={rich} className="mb-6 lg:hidden" />
          ) : null}
          <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(260px,300px)] lg:gap-10">
            <div className={`order-1 min-w-0 ${compactSections ? "space-y-5 lg:space-y-6" : "space-y-8 lg:space-y-10"}`}>
              <ListingDetailCollapsibleSection
                id="floor-plans"
                title={rich.floorPlansSectionTitle ?? "Floor plans"}
                dataAttrToggle="listing-floor-plans-toggle"
                collapseOnMobile={collapseOnMobile}
                compact={compactSections}
                headerAside={
                  roomCount > 0 ? (
                    <span className="rounded-full border border-border bg-accent/35 px-3 py-1 text-xs font-semibold text-foreground listing-detail-surface">
                      {roomCount} room{roomCount === 1 ? "" : "s"}
                    </span>
                  ) : null
                }
              >
                <div className="space-y-4">
                  <FloorPlansSectionBody
                    property={property}
                    rich={rich}
                    propertyLabel={propertyLabel}
                  />
                </div>
              </ListingDetailCollapsibleSection>

              <ListingDetailCollapsibleSection
                id="lease-basics"
                title="Lease basics"
                dataAttrToggle="listing-lease-basics-toggle"
                collapseOnMobile={collapseOnMobile}
                compact={compactSections}
              >
                <LeaseBasicsTableInteractive
                  rows={rich.leaseBasics}
                  listingPropertyId={property.id}
                  propertyLabel={propertyLabel}
                  contactSmsPhone={property.contactSmsPhone}
                  showTermSections={Boolean(rich.shortTermRentalsAllowed)}
                />
              </ListingDetailCollapsibleSection>

              <ListingDetailCollapsibleSection
                id="amenities"
                title="Amenities"
                eyebrow="Building & neighborhood"
                dataAttrToggle="listing-amenities-toggle"
                collapseOnMobile={collapseOnMobile}
                compact={compactSections}
              >
                <AmenitiesTableInteractive rows={rich.amenities} listingPropertyId={property.id} propertyLabel={propertyLabel} contactSmsPhone={property.contactSmsPhone} />
              </ListingDetailCollapsibleSection>

              <ListingDetailCollapsibleSection
                id="bundles"
                title="Bundles & leasing"
                eyebrow="Packages"
                dataAttrToggle="listing-bundles-toggle"
                collapseOnMobile={collapseOnMobile}
                headerAside={
                  <span className="rounded-full border border-border bg-accent/35 px-3 py-1 text-xs font-semibold text-foreground listing-detail-surface">
                    {rich.bundleCards.length} package{rich.bundleCards.length === 1 ? "" : "s"}
                  </span>
                }
              >
                <BundleTableInteractive rows={rich.bundleCards} listingPropertyId={property.id} propertyLabel={propertyLabel} contactSmsPhone={property.contactSmsPhone} />
                <div className="mt-6 rounded-xl border border-border/60 bg-accent/25 p-4 listing-detail-surface sm:p-5">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted">Lease lengths</p>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{formatBoldSegments(rich.bundlesText)}</p>
                </div>
              </ListingDetailCollapsibleSection>

              <ListingDetailCollapsibleSimpleSection
                id="house-rules"
                title="House rules"
                hasContent={Boolean(houseRulesDisplay)}
                emptyMessage="No house rules were added to this listing yet."
                dataAttrToggle="listing-house-rules-toggle"
                collapseOnMobile={collapseOnMobile}
                compact={compactSections}
              >
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{houseRulesDisplay}</p>
              </ListingDetailCollapsibleSimpleSection>

              <ListingDetailCollapsibleSection
                id="location"
                title="Location"
                dataAttrToggle="listing-location-toggle"
                collapseOnMobile={collapseOnMobile}
                compact={compactSections}
              >
                <ListingLocationBlock property={property} embedded />
              </ListingDetailCollapsibleSection>
            </div>

            <Sidebar property={property} rich={rich} className="lg:order-2" />
          </div>
        </div>
      </div>
    </div>
    </ListingSidebarRenterCtasContext.Provider>
    </ListingPreviewNewTabContext.Provider>
  );
}
