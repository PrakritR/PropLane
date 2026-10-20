"use client";

import "@/components/public-site/public-site.css";
import { displayPropertyTitle } from "@/lib/property-title";
import Link from "next/link";
import { BedDouble, CalendarDays, DollarSign, Heart, Share2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ListingStickySubnav } from "@/components/marketing/listing-detail-subnav";
import { ListingLocationBlock } from "@/components/marketing/listing-location-block";
import { SpacesHairlineList } from "@/components/marketing/listing-detail-tables-client";
import { useListingPublicOccupancy } from "@/hooks/use-listing-public-occupancy";
import { countRoomsAvailableNow, nextOpeningDate } from "@/lib/public-listing-available-count";
import { formatNextOpening } from "@/lib/room-availability";
import { pacificTodayKey } from "@/lib/sheet-sync/dates";
import { deriveListingKeyFacts, formatMoneyInLabel, isListingFallbackBathroom, isListingPlaceholderSharedSpace } from "@/components/marketing/listing-key-facts";
import { ListingNoPhotoBand } from "@/components/marketing/listing-photo-mosaic";
import {
  ListingPreviewNewTabContext,
  ListingSidebarRenterCtasContext,
} from "@/components/marketing/listing-preview-context";
import { ShortStayProvider, useShortStay } from "@/components/marketing/short-stay-booking";
import { listingMonthlyPriceLine, listingPriceRows } from "@/lib/listing-price-line";
import { listingShortStayNightlyFrom } from "@/lib/short-stay-request";
import {
  BOOK_TOUR_LABEL,
  ListingActionsProvider,
  ListingPriceCard,
  MonthlyPrimaryCta,
  PriceFigure,
  useListingTextHref,
} from "@/components/marketing/listing-price-card";
import { ProspectListingCta } from "@/components/marketing/prospect-listing-cta";
import { ListingGallery, collectListingPhotos } from "@/components/public-site/listing-gallery";
import type { MockProperty } from "@/data/types";
import { DEFAULT_LISTING_HOUSE_RULES_FALLBACK, type ListingRichContent } from "@/data/listing-rich-content";
import { filterListingSidebarQuickFacts } from "@/data/listing-rich-from-submission";
import { residentCreateAccountHref } from "@/lib/resident-public-nav";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

/**
 * The listing detail page in the approved homepage look: photos first, then the title block, then numbered hairline
 * sections, with one sticky card of actions on desktop and a fixed dock on a phone. The manager's own preview renders
 * THIS component (its `previewModal` / `portalEmbedded` / `managerPreviewChrome` flags only change chrome), so the
 * two can never drift apart. The dock is the public page's alone (`phoneDock`).
 */

const BUNDLE_FACT_ICONS = { rooms: BedDouble, price: DollarSign, stay: CalendarDays } as const;

function formatBoldSegments(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

/** Legacy `homeStructureNote` rows sometimes left a bare story count between middots — label it for display. */
function formatPropertyLayoutQuickFact(value: string): string {
  return value.replace(
    / · (\d+) · (?=\d+(?:\.\d+)?\s*bath)/i,
    (_, n: string) => ` · ${n} ${n === "1" ? "story" : "stories"} · `,
  );
}

function propertyDisplayLabel(property: MockProperty): string | null {
  return property.buildingName?.trim() || property.title?.trim() || property.address?.trim() || null;
}

/** "Central District · Seattle": the neighborhood, then the city out of the address line. */
function placeLine(property: MockProperty): string {
  const address = property.address?.trim() ?? "";
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const city = parts.length >= 2 ? parts[1]! : address;
  return [property.neighborhood?.trim(), city].filter(Boolean).join(" · ");
}

function ShareButton({ property }: { property: MockProperty }) {
  const [copied, setCopied] = useState(false);
  const share = useCallback(async () => {
    if (typeof window === "undefined") return;
    const url = `${resolveEmailLinkBaseUrl()}/rent/listings/${encodeURIComponent(property.id)}`;
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
    <>
      {copied ? (
        <span className="ps-ld-copied" role="status">
          Link copied
        </span>
      ) : null}
      <button type="button" onClick={() => share()} data-attr="listing-share" className="ps-icon-btn" aria-label="Share this listing" title="Share">
        <Share2 className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </button>
    </>
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
      className="ps-icon-btn"
      aria-label="Save this listing"
      title="Save"
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      <Heart className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
    </Link>
  );
}

function AboutBody({ rich }: { rich: ListingRichContent }) {
  const [expanded, setExpanded] = useState(false);
  const overview = rich.heroOverview?.trim();
  // A record that carries only a description stamps it as the tagline too; say it once.
  const rawTagline = rich.heroTagline?.trim();
  const tagline = rawTagline && overview && overview.startsWith(rawTagline) ? undefined : rawTagline;
  const long = (overview?.length ?? 0) > 420;
  return (
    <div className="min-w-0">
      <p className={`ps-ld-prose ${long && !expanded ? "line-clamp-5" : ""}`}>
        {tagline ? <strong>{tagline} </strong> : null}
        {overview ? formatBoldSegments(overview) : null}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          data-attr="listing-overview-read-more"
          aria-expanded={expanded}
          className="ps-ld-more"
        >
          {expanded ? "Read less" : "Read more"}
        </button>
      ) : null}
    </div>
  );
}

/** One numbered hairline section. The number is outside the heading so the heading reads as its title alone. */
function Section({
  id,
  index,
  title,
  aside,
  children,
  scrollClass = "",
}: {
  id: string;
  index: number;
  title: string;
  aside?: string | null;
  children: ReactNode;
  scrollClass?: string;
}) {
  return (
    <section id={id} className={`ps-ld-sec scroll-mt-[var(--listing-sticky-stack,calc(var(--ps-h,64px)+16px))] ${scrollClass}`}>
      <div className="ps-sh">
        <span className="ps-sh-i" aria-hidden>
          {String(index).padStart(2, "0")}
        </span>
        <h2 id={`${id}-heading`}>{title}</h2>
        {aside ? <span className="ps-sh-s">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The page's actions on a phone: Book a tour, Apply (or Request to book on the short-stay segment) and Text us when a
 * number is configured. Fixed to the bottom of the public page only; the portal's preview never draws it. It tells
 * the page (a flag on <html>) so the floating assistant button rides above it.
 */
function PhoneDock({ property, newTab }: { property: MockProperty; newTab: boolean }) {
  const stay = useShortStay();
  const textHref = useListingTextHref(property);
  const shortSegment = stay?.offered === true && stay.segment === "short";
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-ps-dock", "");
    return () => root.removeAttribute("data-ps-dock");
  }, []);
  return (
    <>
      <div className="ps-dock-spacer" aria-hidden />
      <div className="ps-dock" data-attr="listing-sticky-bar" data-dock="">
        <ProspectListingCta action="tour" propertyId={property.id} data-attr="listing-web-tour" className="ps-btn ps-btn-blue" newTab={newTab}>
          {BOOK_TOUR_LABEL}
        </ProspectListingCta>
        {shortSegment ? (
          <button
            type="button"
            className="ps-btn ps-btn-line"
            data-attr="listing-sticky-request"
            onClick={() => document.getElementById("short-stay-card")?.scrollIntoView({ block: "start", behavior: "smooth" })}
          >
            Request to book
          </button>
        ) : (
          <MonthlyPrimaryCta property={property} newTab={newTab} className="ps-btn ps-btn-line" label="short" />
        )}
        {textHref ? (
          <a href={textHref} className="ps-btn ps-btn-line" data-attr="listing-text-tour-dock">
            Text us
          </a>
        ) : null}
      </div>
    </>
  );
}

/**
 * The preview's bar: sticky inside the manager's scroller (never fixed to the window), one row of the price and
 * the two doors. Same destinations as the card.
 */
function StickyBar({
  property,
  rich,
  roomsLine,
  newTab,
  slim = false,
}: {
  property: MockProperty;
  rich: ListingRichContent;
  roomsLine: string | null;
  newTab: boolean;
  /** Manager preview on a phone: one slim row (price and availability left, the primary and Tour right). */
  slim?: boolean;
}) {
  const stay = useShortStay();
  // Exactly one primary and Tour: on the Short stay segment the primary is Request to book, which brings the
  // booking block into view; on Monthly it is the same Quick apply / Continue / Apply the card shows.
  // `stay.offered` is the card's own predicate, so the bar can never offer a segment the card is not on.
  const shortSegment = stay?.offered === true && stay.segment === "short";
  const nightlyFrom = listingShortStayNightlyFrom(property.listingSubmission);
  const from =
    shortSegment && nightlyFrom > 0
      ? `from $${nightlyFrom.toLocaleString("en-US")} / night`
      : (listingMonthlyPriceLine(rich)?.label ?? "");
  const compact = slim ? "!w-auto flex-none !px-4" : "min-w-[7.5rem] flex-1 !px-3";
  const primary = shortSegment ? (
    <button
      type="button"
      className={`ps-btn ps-btn-blue ${compact}`}
      data-attr="listing-sticky-request"
      onClick={() => document.getElementById("short-stay-card")?.scrollIntoView({ block: "start", behavior: "smooth" })}
    >
      Request to book
    </button>
  ) : (
    <MonthlyPrimaryCta property={property} newTab={newTab} className={`ps-btn ps-btn-blue ${compact}`} label={slim ? "short" : undefined} />
  );
  const tour = (
    <ProspectListingCta
      action="tour"
      propertyId={property.id}
      data-attr="listing-web-tour"
      className={`ps-btn ps-btn-line ${compact}`}
      newTab={newTab}
    >
      {slim ? (
        <>
          <span aria-hidden>Tour</span>
          <span className="sr-only">{BOOK_TOUR_LABEL}</span>
        </>
      ) : (
        BOOK_TOUR_LABEL
      )}
    </ProspectListingCta>
  );
  const bar = "sticky bottom-0 z-[40] -mx-4 mt-6 border-t border-[var(--ps-ink)] bg-[var(--ps-paper)] px-4 lg:hidden";
  if (slim) {
    return (
      <div className={`${bar} py-2`} data-attr="listing-sticky-bar" data-slim="">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1">
            {from ? <p className="truncate text-base font-semibold tracking-tight">{from}</p> : null}
            {roomsLine ? <p className="truncate text-xs text-[var(--ps-mute)]">{roomsLine}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2" data-attr="listing-sticky-actions">{primary}{tour}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`${bar} pb-3 pt-2.5`} data-attr="listing-sticky-bar">
      <div className="min-w-0">
        {from ? <p className="truncate text-lg font-semibold tracking-tight">{from}</p> : null}
        {roomsLine ? <p className="truncate text-xs text-[var(--ps-mute)]">{roomsLine}</p> : null}
      </div>
      <div className="mt-2.5 flex gap-2" data-attr="listing-sticky-actions">
        {primary}
        {tour}
      </div>
    </div>
  );
}

function ListingDetailBody({
  property,
  rich,
  previewModal,
  hidePreviewSubnav,
  portalEmbedded,
  managerPreviewChrome,
  hidePortalSubnav,
  onAddPhotos,
  phoneDock,
}: {
  property: MockProperty;
  rich: ListingRichContent;
  previewModal: boolean;
  hidePreviewSubnav: boolean;
  portalEmbedded: boolean;
  managerPreviewChrome: boolean;
  hidePortalSubnav: boolean;
  onAddPhotos?: () => void;
  phoneDock: boolean;
}) {
  const stay = useShortStay();
  const rooms = useMemo(() => rich.floorPlans.flatMap((f) => f.rooms), [rich.floorPlans]);
  const roomCount = rooms.length;
  const { rooms: occupancyRows, loading: occupancyLoading } = useListingPublicOccupancy(property.id);
  // Held back while occupancy loads so a static "9 available" never flashes; a failed fetch leaves no rows, i.e. the static count.
  const availableNow = useMemo(
    () => (occupancyLoading ? null : countRoomsAvailableNow(rooms, occupancyRows, pacificTodayKey(), property.id)),
    [occupancyLoading, rooms, occupancyRows, property.id],
  );
  // Nothing open today: say when the first room frees up instead of "0 available". Waits with the count while loading.
  const nextOpeningLabel = useMemo(() => {
    if (occupancyLoading || availableNow !== 0) return null;
    const today = pacificTodayKey();
    const date = nextOpeningDate(rooms, occupancyRows, today, property.id);
    return date ? formatNextOpening(date, today) : null;
  }, [occupancyLoading, availableNow, rooms, occupancyRows, property.id]);
  const roomsLine =
    roomCount > 0
      ? `${roomCount} room${roomCount === 1 ? "" : "s"}${
          availableNow === null ? "" : ` · ${nextOpeningLabel ?? `${availableNow} available`}`
        }`
      : null;
  const availableLine =
    availableNow === null
      ? null
      : availableNow > 0
        ? roomCount > 1
          ? `${availableNow} of ${roomCount} rooms available now`
          : "Available now"
        : nextOpeningLabel;
  const embeddedPreview = previewModal || portalEmbedded;
  const houseRulesDisplay =
    rich.houseRulesBody?.trim() || (!property.listingSubmission ? DEFAULT_LISTING_HOUSE_RULES_FALLBACK : null);
  // Only an http(s) storage URL ever reaches this component — never a `data:`
  // URL, which `publicListingProjection` already strips before an anonymous
  // caller sees this property (see `public-listings.server.ts`).
  const rawHouseVideoUrl = property.listingSubmission?.houseVideoDataUrl;
  const heroVideoUrl =
    typeof rawHouseVideoUrl === "string" && /^https?:\/\//i.test(rawHouseVideoUrl.trim()) ? rawHouseVideoUrl : null;
  const propertyLabel = propertyDisplayLabel(property);
  const title = displayPropertyTitle(property);
  const photos = useMemo(() => collectListingPhotos(rich, title || "House"), [rich, title]);
  const facts = useMemo(
    () => deriveListingKeyFacts(rich, property, availableNow, nextOpeningLabel),
    [rich, property, availableNow, nextOpeningLabel],
  );
  const metaLine = facts
    .filter((f) => f.id === "rooms" || f.id === "baths" || f.id === "pets")
    .map((f) => f.value)
    .join(" · ");
  const priceLine = listingMonthlyPriceLine(rich);
  const hasAbout = Boolean(rich.heroTagline?.trim() || rich.heroOverview?.trim());
  const quickFacts = filterListingSidebarQuickFacts(rich.quickFacts, property).filter(
    (q) => !QUICK_FACTS_COVERED_ELSEWHERE.has(q.label.trim().toLowerCase()),
  );
  const costRows = listingPriceRows(
    rich,
    property.listingSubmission as Parameters<typeof listingPriceRows>[1],
    stay?.offered === true ? listingShortStayNightlyFrom(property.listingSubmission) : 0,
    formatMoneyInLabel,
  ).filter((row) => row.key !== "rent");
  const hasSpaces =
    roomCount > 0 ||
    rich.bathrooms.some((b) => !isListingFallbackBathroom(b)) ||
    rich.sharedSpaces.some((s) => !isListingPlaceholderSharedSpace(s));
  const hasPackages = rich.bundleCards.length > 0 || Boolean(rich.bundlesText?.trim());

  const sections: { id: string; title: string; aside?: string | null; body: ReactNode }[] = [];
  if (hasAbout || quickFacts.length > 0) {
    sections.push({
      id: "overview",
      title: "About this home",
      body: (
        <>
          {hasAbout ? <AboutBody rich={rich} /> : null}
          {quickFacts.length > 0 ? (
            <ul className={`ps-facts ${hasAbout ? "ps-ld-facts" : ""}`}>
              {quickFacts.map((q) => (
                <li key={q.label}>
                  <span>{q.label}</span>
                  <span>
                    {q.label.trim().toLowerCase() === "property & layout" ? formatPropertyLayoutQuickFact(q.value) : q.value}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ),
    });
  }
  if (hasSpaces) {
    sections.push({
      id: "rooms",
      title: "Rooms",
      aside: roomsLine,
      body: (
        <SpacesHairlineList
          floorPlans={rich.floorPlans}
          bathrooms={rich.bathrooms}
          sharedSpaces={rich.sharedSpaces}
          listingPropertyId={property.id}
          propertyLabel={propertyLabel}
          contactSmsPhone={property.contactSmsPhone}
          signingOrder={property.signingOrder}
        />
      ),
    });
  }
  if (costRows.length > 0) {
    sections.push({
      id: "lease-basics",
      title: "Costs",
      body: (
        <ul className="ps-facts" data-attr="listing-price-rows">
          {costRows.map((row) => (
            <li key={row.key}>
              <span>{row.label}</span>
              <span>{row.value}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (hasPackages) {
    sections.push({
      id: "bundles",
      title: "Bundles & leasing",
      aside: rich.bundleCards.length > 0 ? `${rich.bundleCards.length} package${rich.bundleCards.length === 1 ? "" : "s"}` : null,
      body: (
        <>
          {rich.bundleCards.length > 0 ? (
            <ul className="ps-rows">
              {rich.bundleCards.map((card) => (
                <li key={card.id} className="ps-row ps-room-plain">
                  <div className="ps-row-main">
                    <p className="ps-row-name">{card.label}</p>
                    {card.facts && card.facts.length > 0 ? (
                      <p className="ps-row-sub flex flex-wrap items-center gap-x-4 gap-y-1" data-attr="listing-bundle-facts">
                        {card.facts.map((fact) => {
                          const Icon = BUNDLE_FACT_ICONS[fact.icon];
                          return (
                            <span key={`${fact.icon}-${fact.text}`} className="inline-flex items-center gap-1.5">
                              <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
                              {fact.text}
                            </span>
                          );
                        })}
                      </p>
                    ) : null}
                  </div>
                  <p className="ps-row-fig" style={{ gridArea: "more" }}>
                    {card.strikethrough ? <s className="ps-mute">{card.strikethrough}</s> : null} {card.price}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          {rich.bundlesText?.trim() ? (
            <ul className={`ps-facts ${rich.bundleCards.length > 0 ? "ps-ld-facts" : ""}`}>
              <li>
                <span>Lease lengths</span>
                <span>{formatBoldSegments(rich.bundlesText)}</span>
              </li>
            </ul>
          ) : null}
        </>
      ),
    });
  }
  if (houseRulesDisplay) {
    sections.push({
      id: "house-rules",
      title: "House rules",
      body: <p className="ps-ld-prose">{houseRulesDisplay}</p>,
    });
  }
  if (rich.amenities.length > 0) {
    sections.push({
      id: "amenities",
      title: "Amenities",
      aside: String(rich.amenities.length),
      body: (
        <ul className="ps-amen">
          {rich.amenities.map((a) => (
            <li key={a.id}>{a.label}</li>
          ))}
        </ul>
      ),
    });
  }
  sections.push({
    id: "location",
    title: "Location",
    body: (
      <div className="ps-ld-map">
        <ListingLocationBlock property={property} embedded shortOnPhone={managerPreviewChrome} />
      </div>
    ),
  });

  const addressMargin = embeddedPreview
    ? managerPreviewChrome
      ? "!pb-0 !pt-0"
      : "!pb-8 !pt-2"
    : "[html[data-native]_&]:pb-[max(2rem,env(safe-area-inset-bottom))] [html[data-native]_&]:pt-[max(0.5rem,env(safe-area-inset-top))]";

  return (
    <div
      className={`ps ps-ld @container min-w-0 max-w-full ${
        managerPreviewChrome ? "[&_[data-attr=listing-key-facts]_p]:[font-variant-numeric:normal]" : ""
      }`}
      data-listing-sections-root
      data-manager-listing-preview={managerPreviewChrome ? "" : undefined}
    >
      <div className={`ps-wrap ps-ld-in flex min-w-0 flex-col ${addressMargin}`}>
        {previewModal && !hidePreviewSubnav ? (
          <ListingStickySubnav mode="modal" />
        ) : embeddedPreview ? null : (
          <Link href="/rent/browse" data-attr="listing-detail-back" className="ps-link ps-ld-back">
            ← All homes
          </Link>
        )}

        {/* Photos first. A manager's own preview with none keeps the one-line band and its Add photos action. */}
        {photos.length === 0 && managerPreviewChrome ? (
          <ListingNoPhotoBand onAddPhotos={onAddPhotos} videoUrl={heroVideoUrl} />
        ) : (
          <ListingGallery key={photos.map((p) => p.url).join("|")} photos={photos} videoUrl={heroVideoUrl} />
        )}

        <div className="ps-ld-title">
          <div className="ps-ld-titlerow">
            <h1 className="ps-h2">{title}</h1>
            {managerPreviewChrome ? null : (
              <div className="ps-ld-tools">
                <ShareButton property={property} />
                <SaveButton property={property} newTab={embeddedPreview} />
              </div>
            )}
          </div>
          {placeLine(property) ? <p className="ps-ld-place">{placeLine(property)}</p> : null}
          {/* The desktop card carries the price and the date at the top of the viewport; the title block does it below that width. */}
          {priceLine ? <PriceFigure label={priceLine.label} className="ps-ld-titleprice" data-attr="listing-title-price" /> : null}
          {availableLine ? <p className="ps-ld-avail ps-ld-titleavail">{availableLine}</p> : null}
          {metaLine ? <p className="ps-ld-meta">{metaLine}</p> : null}
        </div>

        <div
          className="ps-ld-grid grid min-w-0 gap-10 @min-[900px]:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] @min-[900px]:gap-14"
          data-listing-about-grid
        >
          <div className="min-w-0">
            {portalEmbedded ? (
              hidePortalSubnav ? null : <ListingStickySubnav mode="portal" appearance="portal" className="mb-5" />
            ) : !previewModal && !phoneDock ? (
              <ListingStickySubnav className="mb-5" />
            ) : null}

            {/* Phone: the pickers (and short-stay booking) in the page, between the title and the sections. */}
            <div className="mb-10 empty:hidden lg:hidden @min-[900px]:hidden" id="short-stay-card" data-attr="listing-phone-price-card">
              <ListingPriceCard property={property} rich={rich} newTab={embeddedPreview} variant="inline" showActions={!phoneDock} />
            </div>
            <div className="mb-10 hidden lg:block @min-[900px]:hidden" data-listing-price-card-stack>
              <ListingPriceCard property={property} rich={rich} newTab={embeddedPreview} availableLine={availableLine} />
            </div>

            <div>
              {sections.map((section, i) => (
                <Section
                  key={section.id}
                  id={section.id}
                  index={i + 1}
                  title={section.title}
                  aside={section.aside}
                  scrollClass={managerPreviewChrome && hidePortalSubnav ? "max-lg:!scroll-mt-[calc(var(--listing-sticky-stack,3.25rem)+0.75rem)]" : ""}
                >
                  {section.body}
                </Section>
              ))}
            </div>
          </div>

          <aside
            className={`hidden @min-[900px]:block @min-[900px]:self-start @min-[900px]:sticky ${
              embeddedPreview
                ? "@min-[900px]:top-[var(--listing-sticky-stack,calc(env(safe-area-inset-top,0px)+7.5rem))]"
                : "@min-[900px]:top-[calc(var(--ps-h,64px)+24px)]"
            }`}
          >
            <ListingPriceCard property={property} rich={rich} newTab={embeddedPreview} availableLine={availableLine} />
          </aside>
        </div>

        {phoneDock ? (
          <PhoneDock property={property} newTab={embeddedPreview} />
        ) : (
          <StickyBar property={property} rich={rich} roomsLine={roomsLine} newTab={embeddedPreview} slim={managerPreviewChrome} />
        )}
      </div>
    </div>
  );
}

const QUICK_FACTS_COVERED_ELSEWHERE = new Set(["rooms listed", "rooms", "bathrooms", "pets", "building", "neighborhood", "overview"]);

export function ListingDetailSections({
  property,
  rich,
  previewModal = false,
  hidePreviewSubnav = false,
  /** Manager property preview — scrolls inside #portal-main-content with a sticky section subnav. */
  portalEmbedded = false,
  /** The manager's own preview: the same page, plus the one action that fixes an empty photo band. */
  managerPreviewChrome = false,
  /** Parent renders listing section tabs in property detail chrome (manager preview). */
  hidePortalSubnav = false,
  /** Manager preview only — opens the listing editor on its photo step. */
  onAddPhotos,
  /** The public page only: the fixed bottom action bar on a phone. Never inside the portal. */
  phoneDock = false,
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
  phoneDock?: boolean;
}) {
  const embeddedPreview = previewModal || portalEmbedded;
  return (
    <ListingPreviewNewTabContext.Provider value={embeddedPreview}>
      <ShortStayProvider property={property} disabled={embeddedPreview}>
        <ListingActionsProvider property={property} preview={embeddedPreview}>
          <ListingSidebarRenterCtasContext.Provider value>
            <ListingDetailBody
              property={property}
              rich={rich}
              previewModal={previewModal}
              hidePreviewSubnav={hidePreviewSubnav}
              portalEmbedded={portalEmbedded}
              managerPreviewChrome={managerPreviewChrome}
              hidePortalSubnav={hidePortalSubnav}
              onAddPhotos={onAddPhotos}
              phoneDock={phoneDock && !embeddedPreview}
            />
          </ListingSidebarRenterCtasContext.Provider>
        </ListingActionsProvider>
      </ShortStayProvider>
    </ListingPreviewNewTabContext.Provider>
  );
}
