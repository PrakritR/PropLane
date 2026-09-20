"use client";

import Link from "next/link";
import { Heart, Mail, MessageSquareText, Share2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
  SpacesInteractive,
} from "@/components/marketing/listing-detail-tables-client";
import { ListingKeyFacts, deriveListingKeyFacts, formatMoneyInLabel } from "@/components/marketing/listing-key-facts";
import { ListingNoPhotoBand, ListingPhotoMosaic } from "@/components/marketing/listing-photo-mosaic";
import {
  ListingContactCard,
  listingContactRows,
  listingPrimaryCtaClass,
  listingSecondaryCtaClass,
} from "@/components/marketing/listing-contact-card";
import {
  ListingPreviewNewTabContext,
  ListingSidebarRenterCtasContext,
} from "@/components/marketing/listing-preview-context";
import { ProspectListingCta } from "@/components/marketing/prospect-listing-cta";
import type { MockProperty } from "@/data/types";
import { DEFAULT_LISTING_HOUSE_RULES_FALLBACK, type ListingRichContent } from "@/data/listing-rich-content";
import { filterListingSidebarQuickFacts } from "@/data/listing-rich-from-submission";
import { roomAvailabilityTone } from "@/lib/room-availability-style";
import { residentCreateAccountHref } from "@/lib/resident-public-nav";

/**
 * The listing detail page (PLAN-0914-2124), in the order a renter reads it:
 * title → photos (or the one-line "coming soon" band) → the five key facts →
 * the sections, with one sticky card of actions on desktop and one sticky bar
 * on a phone. The manager's own preview renders THIS component unchanged — the
 * only thing it adds is an "Add photos" button in the empty band — so the two
 * can never drift apart again.
 */

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

const primaryCtaClass = listingPrimaryCtaClass;
const secondaryCtaClass = listingSecondaryCtaClass;
const iconButtonClass =
  "listing-detail-control inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-[13px] font-semibold text-foreground shadow-sm transition hover:border-primary/45 hover:bg-accent/35";

const QUICK_FACTS_COVERED_BY_TILES = new Set(["rooms listed", "rooms", "bathrooms", "pets", "building", "neighborhood", "overview"]);

function listingFromPrice(rich: ListingRichContent): string {
  return formatMoneyInLabel(rich.startingRentLabel?.trim() || rich.priceRangeLabel.replace(/^\s*base rent\s*/i, ""));
}

function propertyDisplayLabel(property: MockProperty): string | null {
  return property.buildingName?.trim() || property.title?.trim() || property.address?.trim() || null;
}

function ShareButton({ property }: { property: MockProperty }) {
  const [copied, setCopied] = useState(false);
  const share = useCallback(async () => {
    if (typeof window === "undefined") return;
    const url = window.location.href;
    const title = propertyDisplayLabel(property) ?? "PropLane listing";
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, url });
        return;
      }
    } catch {
      // The share sheet was dismissed; nothing to copy.
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable — the address bar is the fallback.
    }
  }, [property]);
  return (
    <button type="button" onClick={() => share()} data-attr="listing-share" className={iconButtonClass} aria-label="Share this listing">
      <Share2 className="h-4 w-4" strokeWidth={2} aria-hidden />
      <span className="hidden sm:inline">{copied ? "Copied" : "Share"}</span>
    </button>
  );
}

function SaveButton({ property, newTab }: { property: MockProperty; newTab: boolean }) {
  // Saving a home lives with a resident account; until one exists the heart
  // opens the same create-account door the browse page uses.
  const href = residentCreateAccountHref(`/rent/listings/${encodeURIComponent(property.id)}`);
  return (
    <Link
      href={href}
      data-attr="listing-save"
      className={iconButtonClass}
      aria-label="Save this listing"
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      <Heart className="h-4 w-4" strokeWidth={2} aria-hidden />
      <span className="hidden sm:inline">Save</span>
    </Link>
  );
}

function AboutBody({ rich }: { rich: ListingRichContent }) {
  const [expanded, setExpanded] = useState(false);
  const tagline = rich.heroTagline?.trim();
  const overview = rich.heroOverview?.trim();
  const long = (overview?.length ?? 0) > 420;
  return (
    <div className="min-w-0 max-w-3xl">
      <p
        className={`whitespace-pre-wrap text-sm leading-relaxed text-foreground/85 sm:text-[0.9375rem] ${
          long && !expanded ? "line-clamp-5" : ""
        }`}
      >
        {tagline ? <strong className="font-semibold text-foreground">{tagline} </strong> : null}
        {overview ? formatBoldSegments(overview) : null}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          data-attr="listing-overview-read-more"
          aria-expanded={expanded}
          className="mt-2 text-sm font-semibold text-primary hover:underline"
        >
          {expanded ? "Read less" : "Read more"}
        </button>
      ) : null}
    </div>
  );
}

function PriceCard({
  property,
  rich,
  newTab,
  className = "",
}: {
  property: MockProperty;
  rich: ListingRichContent;
  newTab: boolean;
  className?: string;
}) {
  const estimated = rich.estimatedMonthlyTotalLabel?.trim() ? formatMoneyInLabel(rich.estimatedMonthlyTotalLabel.trim()) : undefined;
  const from = listingFromPrice(rich);
  return (
    <div className={`overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm listing-detail-surface ${className}`} data-attr="listing-price-card">
      <p className="text-xs font-semibold text-muted">Base rent from</p>
      <p className="mt-0.5 text-3xl font-bold tracking-tight text-foreground tabular-nums">{from}</p>
      {estimated || (rich.pricingBreakdown?.length ?? 0) > 0 ? (
        <dl className="mt-3 divide-y divide-border border-y border-border text-sm">
          {estimated ? (
            <div className="flex items-baseline justify-between gap-3 py-2">
              <dt className="text-muted">Est. with utilities</dt>
              <dd className="font-bold tabular-nums text-foreground">{estimated}</dd>
            </div>
          ) : null}
          {rich.pricingBreakdown?.map((line) => (
            <div key={line.label} className="flex items-baseline justify-between gap-3 py-2">
              <dt className="text-muted">{line.label}</dt>
              <dd className="font-bold tabular-nums text-foreground">{formatMoneyInLabel(line.value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="mt-4 space-y-2.5">
        <ProspectListingCta action="tour" propertyId={property.id} data-attr="listing-web-tour" className={primaryCtaClass} newTab={newTab}>
          Schedule tour
        </ProspectListingCta>
        <ProspectListingCta action="apply" propertyId={property.id} data-attr="listing-web-apply" className={secondaryCtaClass} newTab={newTab}>
          Apply
        </ProspectListingCta>
        <ListingContactCard property={property} />
      </div>
    </div>
  );
}

/**
 * The phone's action bar (captain, Sep 15): two rows, so nothing is ever cut
 * off. The old single row squeezed the price and "9 rooms · 9 available"
 * into whatever was left beside two pills and the assistant bubble — on a
 * 393px phone that was 48px, and it rendered "$1,…" / "9 roo…".
 *
 * Row one is the price and the rooms line at full width, with the manager's
 * two doors (the work number, the work email) as compact pills on the right
 * when the listing has them — the same server-resolved fields the desktop
 * card prints, never a personal phone or `profiles.email`. Row two is Apply
 * and Schedule tour, half the width each. The row that shares its height with
 * the assistant bubble keeps clear of it only when a bubble is on the page.
 */
function StickyBar({
  property,
  rich,
  roomsLine,
  newTab,
}: {
  property: MockProperty;
  rich: ListingRichContent;
  roomsLine: string | null;
  newTab: boolean;
}) {
  const from = listingFromPrice(rich);
  const doors = listingContactRows(property);
  const doorClass =
    "inline-flex min-h-[38px] min-w-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[13px] font-semibold text-foreground shadow-sm transition hover:border-primary/45 hover:bg-accent/35";
  // With both doors the number is the label worth reading; Email folds to its
  // icon so the price keeps room. Alone, Email says so in words.
  const emailIconOnly = Boolean(doors.phone && doors.email);
  return (
    <div
      className="sticky bottom-0 z-[40] -mx-4 mt-6 border-t border-border bg-card/95 px-4 pb-3 pt-2.5 backdrop-blur-md lg:hidden [html[data-native]_&]:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      data-attr="listing-sticky-bar"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-[7rem] flex-1">
          {/* No tabular figures here: the brand face gives the comma a digit's
              width under `tnum`, which reads as "$1 , 050" in a lone price. */}
          <p className="truncate text-lg font-bold tracking-tight text-foreground">{from}</p>
          {roomsLine ? <p className="truncate text-xs text-muted">{roomsLine}</p> : null}
        </div>
        {doors.phone || doors.email ? (
          <div className="flex min-w-0 shrink items-center gap-1.5" data-attr="listing-sticky-contact">
            {doors.phone ? (
              <a href={doors.phone.smsHref} className={doorClass} data-attr="listing-sticky-text" aria-label={`Text ${doors.phone.label}`}>
                <MessageSquareText className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="truncate">{doors.phone.label}</span>
              </a>
            ) : null}
            {doors.email ? (
              <a
                href={doors.email.href}
                className={`${doorClass} ${emailIconOnly ? "w-[38px] shrink-0 justify-center !px-0" : ""}`}
                data-attr="listing-sticky-email"
                aria-label="Email the manager"
              >
                <Mail className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                {emailIconOnly ? null : <span className="truncate">Email</span>}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-2 [body:has(.axis-assistant-fab)_&]:pr-[3.25rem]">
        <ProspectListingCta
          action="apply"
          propertyId={property.id}
          data-attr="listing-web-apply"
          className={`${secondaryCtaClass} !min-h-[44px] !py-2.5`}
          newTab={newTab}
        >
          Apply
        </ProspectListingCta>
        <ProspectListingCta
          action="tour"
          propertyId={property.id}
          data-attr="listing-web-tour"
          className={`${primaryCtaClass} !min-h-[44px] !py-2.5`}
          newTab={newTab}
        >
          Schedule tour
        </ProspectListingCta>
      </div>
    </div>
  );
}

export function ListingDetailSections({
  property,
  rich,
  previewModal = false,
  hidePreviewSubnav = false,
  /** Manager property preview — scrolls inside #portal-main-content with a sticky section subnav. */
  portalEmbedded = false,
  /** Show every section open on a phone (the public route); the preview modal keeps its accordions. */
  expandSectionsOnMobile = false,
  /** The manager's own preview: the same page, plus the one action that fixes an empty photo band. */
  managerPreviewChrome = false,
  /** Parent renders listing section tabs in property detail chrome (manager preview). */
  hidePortalSubnav = false,
  /** Manager preview only — opens the listing editor on its photo step. */
  onAddPhotos,
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
  onAddPhotos?: () => void;
}) {
  const rooms = useMemo(() => rich.floorPlans.flatMap((f) => f.rooms), [rich.floorPlans]);
  const roomCount = rooms.length;
  const availableNow = rooms.filter((r) => roomAvailabilityTone(r.availability) === "available").length;
  const roomsLine =
    roomCount > 0 ? `${roomCount} room${roomCount === 1 ? "" : "s"} · ${availableNow} available` : null;
  const collapseOnMobile = !expandSectionsOnMobile;
  const embeddedPreview = previewModal || portalEmbedded;
  const houseRulesDisplay =
    rich.houseRulesBody?.trim() || (!property.listingSubmission ? DEFAULT_LISTING_HOUSE_RULES_FALLBACK : null);
  const heroUrls = rich.heroHousePhotoUrls ?? [];
  const propertyLabel = propertyDisplayLabel(property);
  const facts = useMemo(
    () => deriveListingKeyFacts(rich, property, managerPreviewChrome ? { photoCount: heroUrls.length } : {}),
    [rich, property, managerPreviewChrome, heroUrls.length],
  );
  const hasAbout = Boolean(rich.heroTagline?.trim() || rich.heroOverview?.trim());
  // The tiles already say rooms, baths and pets; the ledger keeps only what they do not.
  const quickFacts = filterListingSidebarQuickFacts(rich.quickFacts, property).filter(
    (q) => !QUICK_FACTS_COVERED_BY_TILES.has(q.label.trim().toLowerCase()),
  );
  const addressLine = [property.address?.trim(), property.neighborhood?.trim()].filter(Boolean).join(" · ");

  return (
    <ListingPreviewNewTabContext.Provider value={embeddedPreview}>
      <ListingSidebarRenterCtasContext.Provider value>
        <div className="@container min-w-0 max-w-full bg-background text-foreground" data-listing-sections-root data-manager-listing-preview={managerPreviewChrome ? "" : undefined}>
          <div
            className={`mx-auto flex min-w-0 max-w-6xl flex-col px-4 ${
              embeddedPreview
                ? managerPreviewChrome
                  ? "pb-0 pt-0 sm:px-4"
                  : "pb-8 pt-2 sm:pb-10 sm:pt-3"
                : "py-6 sm:py-8 [html[data-native]_&]:pb-[max(2rem,env(safe-area-inset-bottom))] [html[data-native]_&]:pt-[max(0.5rem,env(safe-area-inset-top))]"
            }`}
          >
            {previewModal && !hidePreviewSubnav ? (
              <ListingStickySubnav mode="modal" />
            ) : embeddedPreview ? null : (
              <Link
                href="/rent/browse"
                data-attr="listing-detail-back"
                className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:opacity-90"
              >
                ← Back to homes
              </Link>
            )}

            {/* Title row */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl md:text-[2.125rem] md:leading-tight">
                  {property.title}
                </h1>
                {addressLine ? <p className="mt-1 text-sm text-muted sm:text-[0.9375rem]">{addressLine}</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ShareButton property={property} />
                <SaveButton property={property} newTab={embeddedPreview} />
              </div>
            </div>

            {/* Photos, or the one-line band */}
            {heroUrls.length > 0 ? (
              <ListingPhotoMosaic key={heroUrls.join("|")} urls={heroUrls} className="mt-4" />
            ) : (
              <ListingNoPhotoBand className="mt-4" onAddPhotos={managerPreviewChrome ? onAddPhotos : undefined} />
            )}

            <ListingKeyFacts facts={facts} className="mt-4" />

            {/* Phone: the manager's doors sit under the title; desktop has them in the card. */}
            <ListingContactCard property={property} className="mt-3 lg:hidden" />

            <div
              className="mt-6 grid min-w-0 gap-8 lg:mt-8 @min-[900px]:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] @min-[900px]:gap-10"
              data-listing-about-grid
            >
              <div className="min-w-0">
                {portalEmbedded ? (
                  hidePortalSubnav ? null : (
                    <ListingStickySubnav mode="portal" appearance="portal" className="mb-5 sm:rounded-2xl" />
                  )
                ) : !previewModal ? (
                  <ListingStickySubnav className="mb-5" />
                ) : null}

                <div className="space-y-6">
                  {hasAbout || quickFacts.length > 0 ? (
                    <ListingDetailCollapsibleSection
                      id="overview"
                      title="About this home"
                      collapseOnMobile={false}
                      dataAttrToggle="listing-overview-toggle"
                    >
                      {hasAbout ? <AboutBody rich={rich} /> : null}
                      {quickFacts.length > 0 ? (
                        <dl className={hasAbout ? "mt-4" : ""}>
                          {quickFacts.map((q) => (
                            <div
                              key={q.label}
                              className="grid gap-1 border-b border-border py-2 text-sm sm:grid-cols-[minmax(7.5rem,auto)_minmax(0,1fr)] sm:items-start sm:gap-4"
                            >
                              <dt className="text-muted">{q.label}</dt>
                              <dd className="min-w-0 text-pretty break-words font-semibold leading-relaxed text-foreground">
                                {q.value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                    </ListingDetailCollapsibleSection>
                  ) : (
                    <div id="overview" aria-hidden />
                  )}
                  <div className="hidden lg:block @min-[900px]:hidden" data-listing-price-card-stack>
                    <PriceCard property={property} rich={rich} newTab={embeddedPreview} />
                  </div>

                  <ListingDetailCollapsibleSection
                    id="rooms"
                    title="Rooms"
                    dataAttrToggle="listing-rooms-toggle"
                    collapseOnMobile={collapseOnMobile}
                    defaultOpen
                    headerAside={
                      roomsLine ? (
                        <span className="rounded-full border border-border bg-accent/35 px-3 py-1 text-xs font-semibold text-foreground listing-detail-surface">
                          {roomsLine}
                        </span>
                      ) : null
                    }
                  >
                    <SpacesInteractive
                      floorPlans={rich.floorPlans}
                      bathrooms={rich.bathrooms}
                      sharedSpaces={rich.sharedSpaces}
                      listingPropertyId={property.id}
                      propertyLabel={propertyLabel}
                      contactSmsPhone={property.contactSmsPhone}
                    />
                  </ListingDetailCollapsibleSection>

                  <ListingDetailCollapsibleSection
                    id="lease-basics"
                    title="Lease basics"
                    dataAttrToggle="listing-lease-basics-toggle"
                    collapseOnMobile={collapseOnMobile}
                  >
                    {rich.leaseBasics.length > 0 ? (
                      <LeaseBasicsTableInteractive
                        rows={rich.leaseBasics}
                        listingPropertyId={property.id}
                        propertyLabel={propertyLabel}
                        contactSmsPhone={property.contactSmsPhone}
                        showTermSections={Boolean(rich.shortTermRentalsAllowed)}
                      />
                    ) : (
                      <p className="text-sm text-muted">No lease details were added to this listing yet.</p>
                    )}
                  </ListingDetailCollapsibleSection>

                  <ListingDetailCollapsibleSection
                    id="amenities"
                    title="Amenities"
                    dataAttrToggle="listing-amenities-toggle"
                    collapseOnMobile={collapseOnMobile}
                    headerAside={
                      rich.amenities.length > 0 ? (
                        <span className="rounded-full border border-border bg-accent/35 px-3 py-1 text-xs font-semibold text-foreground listing-detail-surface">
                          {rich.amenities.length}
                        </span>
                      ) : null
                    }
                  >
                    {rich.amenities.length > 0 ? (
                      <AmenitiesTableInteractive rows={rich.amenities} />
                    ) : (
                      <p className="text-sm text-muted">No amenities were added to this listing yet.</p>
                    )}
                  </ListingDetailCollapsibleSection>

                  <ListingDetailCollapsibleSection
                    id="bundles"
                    title="Bundles & leasing"
                    dataAttrToggle="listing-bundles-toggle"
                    collapseOnMobile={collapseOnMobile}
                    headerAside={
                      rich.bundleCards.length > 0 ? (
                        <span className="rounded-full border border-border bg-accent/35 px-3 py-1 text-xs font-semibold text-foreground listing-detail-surface">
                          {rich.bundleCards.length} package{rich.bundleCards.length === 1 ? "" : "s"}
                        </span>
                      ) : null
                    }
                  >
                    {rich.bundleCards.length > 0 ? (
                      <BundleTableInteractive
                        rows={rich.bundleCards}
                        listingPropertyId={property.id}
                        propertyLabel={propertyLabel}
                        contactSmsPhone={property.contactSmsPhone}
                      />
                    ) : null}
                    {rich.bundlesText?.trim() ? (
                      <div className={`rounded-xl border border-border bg-accent/25 p-4 listing-detail-surface ${rich.bundleCards.length > 0 ? "mt-5" : ""}`}>
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">Lease lengths</p>
                        <p className="mt-1.5 text-sm leading-relaxed text-foreground/85">{formatBoldSegments(rich.bundlesText)}</p>
                      </div>
                    ) : null}
                  </ListingDetailCollapsibleSection>

                  <ListingDetailCollapsibleSimpleSection
                    id="house-rules"
                    title="House rules"
                    hasContent={Boolean(houseRulesDisplay)}
                    emptyMessage="No house rules were added to this listing yet."
                    dataAttrToggle="listing-house-rules-toggle"
                    collapseOnMobile={collapseOnMobile}
                  >
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{houseRulesDisplay}</p>
                  </ListingDetailCollapsibleSimpleSection>

                  <ListingDetailCollapsibleSection
                    id="location"
                    title="Location"
                    dataAttrToggle="listing-location-toggle"
                    collapseOnMobile={collapseOnMobile}
                  >
                    <ListingLocationBlock property={property} embedded />
                  </ListingDetailCollapsibleSection>
                </div>
              </div>

              <aside className="hidden @min-[900px]:sticky @min-[900px]:top-[var(--listing-sticky-stack,calc(env(safe-area-inset-top,0px)+7.5rem))] @min-[900px]:block @min-[900px]:self-start">
                <PriceCard property={property} rich={rich} newTab={embeddedPreview} />
              </aside>
            </div>

            <StickyBar property={property} rich={rich} roomsLine={roomsLine} newTab={embeddedPreview} />
          </div>
        </div>
      </ListingSidebarRenterCtasContext.Provider>
    </ListingPreviewNewTabContext.Provider>
  );
}
