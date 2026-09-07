"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  RESIDENT_BATHROOM_OPTIONS,
  RESIDENT_HOUSING_BUDGET_MAX,
  RESIDENT_HOUSING_BUDGET_MIN,
  RESIDENT_HOUSING_BUDGET_STEP,
  RESIDENT_HOUSING_INPUT_CLS,
  RESIDENT_ROOM_TYPE_OPTIONS,
  ResidentHousingChat,
  ResidentHousingFieldBlock,
  type HousingChatAppliedFilters,
} from "@/components/marketing/resident-listing-search";
import { usePublicListings } from "@/hooks/use-public-listings";
import { HousingBrowseSwipeStack } from "@/components/marketing/housing-browse-swipe-stack";
import { browseCardNeighborhoodLine } from "@/components/marketing/housing-browse-card-overlay";
import {
  buildPropertyBrowseCards,
  demoOnlyBrowseCardPlaceholderImage,
  type BrowseSortId,
  type PropertyBrowseCard,
} from "@/lib/room-listings-catalog";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import {
  PortalFilterSortSheet,
  portalFilterActiveCount,
} from "@/components/portal/portal-filter-sort-sheet";
import {
  PORTAL_FILTER_BROWSE_MOBILE_SHEET_CLASS,
  PORTAL_FILTER_BROWSE_PANEL_CLASS,
} from "@/components/portal/filter-field-lists";

const SORT_OPTIONS: { id: BrowseSortId; label: string }[] = [
  { id: "price-asc", label: "Price · lowest first" },
  { id: "price-desc", label: "Price · highest first" },
  { id: "neighborhood", label: "Neighborhood A–Z" },
];

function clampBudget(n: number) {
  const stepped = Math.round(n / RESIDENT_HOUSING_BUDGET_STEP) * RESIDENT_HOUSING_BUDGET_STEP;
  return Math.min(RESIDENT_HOUSING_BUDGET_MAX, Math.max(RESIDENT_HOUSING_BUDGET_MIN, stepped));
}

function formatRent(card: PropertyBrowseCard): string {
  const display = card.headlineRent ?? card.rentNumeric;
  if (display !== null) {
    return formatRoomPriceAmount(display);
  }
  const stripped = card.priceLabel.replace(/\/month/i, "").replace(/\/day/i, "").trim();
  return stripped || "—";
}

function periodSuffix(card: PropertyBrowseCard): string {
  if (card.pricePeriod === "day") return " / day";
  if (card.pricePeriod === "week") return " / week";
  return " / month";
}

function BrowseSkeleton() {
  return (
    <>
      <div className="lg:hidden" aria-hidden>
        <div className="mx-auto h-[min(62dvh,520px)] w-full max-w-[min(100%,22rem)] animate-pulse rounded-3xl bg-gradient-to-br from-accent/40 to-accent/10" />
      </div>
      <div
        className="mx-auto hidden max-w-5xl gap-4 pb-2 sm:gap-5 lg:grid lg:grid-cols-3"
        aria-hidden
      >
        {Array.from({ length: 3 }, (_, i) => (
          <div
            key={i}
            className="aspect-[4/5] animate-pulse rounded-2xl bg-gradient-to-br from-accent/40 to-accent/10"
          />
        ))}
      </div>
    </>
  );
}

function HousingBrowseCard({ card }: { card: PropertyBrowseCard }) {
  const rent = formatRent(card);
  const resolvedImageUrl =
    card.imageUrl || (isDemoModeActive() ? demoOnlyBrowseCardPlaceholderImage(card.propertyId) : "");
  const isDataUrl = resolvedImageUrl.startsWith("data:");
  const hasPhoto = Boolean(resolvedImageUrl);

  return (
    <Link
      href={`/rent/listings/${encodeURIComponent(card.propertyId)}`}
      data-attr="resident-browse-listing-card"
      className="group flex w-full flex-col overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm transition duration-300 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-accent/20">
        {hasPhoto ? (
          <>
            <Image
              src={resolvedImageUrl}
              alt=""
              fill
              className="object-cover transition duration-500 group-hover:scale-[1.03]"
              sizes="(max-width: 1280px) 30vw, 340px"
              unoptimized={isDataUrl}
            />
            {/* Legibility scrim only — kept subtle since text now sits below the image. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-black/15 to-transparent" />
          </>
        ) : (
          <NoImagePlaceholder variant="branded" />
        )}
        {card.petFriendly ? (
          <span className="absolute left-2.5 top-2.5 rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
            Pets OK
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-3.5">
        <p className="line-clamp-1 text-xs font-medium text-muted">
          {browseCardNeighborhoodLine(card)}
        </p>
        <p className="line-clamp-1 text-sm font-semibold text-foreground">
          {card.headlineAddress}
        </p>
        <p className="mt-1 text-lg font-bold tracking-tight text-foreground">
          {rent}
          <span className="text-xs font-medium text-muted">{periodSuffix(card)}</span>
        </p>
      </div>
      <div className="sr-only">
        {card.headlineAddress}, {card.neighborhood}, {rent}{card.pricePeriod === "day" ? " per day" : card.pricePeriod === "week" ? " per week" : " per month"}
      </div>
    </Link>
  );
}

function CarouselArrow({
  direction,
  disabled,
  onClick,
}: {
  direction: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === "left" ? "Previous homes" : "Next homes"}
      data-attr={direction === "left" ? "resident-browse-carousel-prev" : "resident-browse-carousel-next"}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card/80 text-foreground shadow-sm backdrop-blur-sm transition hover:border-primary/35 hover:bg-card disabled:cursor-not-allowed disabled:opacity-35"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
        {direction === "left" ? (
          <path d="M14 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M10 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </button>
  );
}

function HousingBrowseCarousel({ cards }: { cards: PropertyBrowseCard[] }) {
  const [startIndex, setStartIndex] = useState(0);
  const visibleCount = 3;
  const maxStart = Math.max(0, cards.length - visibleCount);
  const cardKey = cards.map((c) => c.propertyId).join(",");

  useEffect(() => {
    setStartIndex(0);
  }, [cardKey]);

  useEffect(() => {
    if (startIndex > maxStart) setStartIndex(maxStart);
  }, [startIndex, maxStart]);

  const visible = cards.slice(startIndex, startIndex + visibleCount);
  const placeholders = Math.max(0, visibleCount - visible.length);
  const canScroll = maxStart > 0;

  return (
    <div className="mx-auto flex max-w-5xl items-center gap-3 sm:gap-4">
      {canScroll ? (
        <CarouselArrow
          direction="left"
          disabled={startIndex <= 0}
          onClick={() => setStartIndex((i) => Math.max(0, i - 1))}
        />
      ) : null}
      <div className="grid min-w-0 flex-1 grid-cols-3 gap-4 sm:gap-5" aria-label="Available rental homes">
        {visible.map((card) => (
          <HousingBrowseCard key={card.propertyId} card={card} />
        ))}
        {Array.from({ length: placeholders }, (_, i) => (
          <div key={`pad-${i}`} aria-hidden />
        ))}
      </div>
      {canScroll ? (
        <CarouselArrow
          direction="right"
          disabled={startIndex >= maxStart}
          onClick={() => setStartIndex((i) => Math.min(maxStart, i + 1))}
        />
      ) : null}
    </div>
  );
}

function BrowseManualFilters({
  moveIn,
  setMoveIn,
  moveOut,
  setMoveOut,
  budget,
  setBudget,
  bathroom,
  setBathroom,
  roomType,
  setRoomType,
  activeCount,
  onClear,
}: {
  moveIn: string;
  setMoveIn: (v: string) => void;
  moveOut: string;
  setMoveOut: (v: string) => void;
  budget: number;
  setBudget: (v: number) => void;
  bathroom: string;
  setBathroom: (v: string) => void;
  roomType: string;
  setRoomType: (v: string) => void;
  activeCount: number;
  onClear: () => void;
}) {
  const budgetActive = budget < RESIDENT_HOUSING_BUDGET_MAX;
  const budgetLabel = budgetActive ? `$${budget.toLocaleString()}` : "Any";

  return (
    <div className="min-w-0 max-w-full space-y-4 overflow-x-hidden sm:space-y-5">
      <div className="grid min-w-0 max-w-full grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        <ResidentHousingFieldBlock label="Move-in date">
          <input
            type="date"
            value={moveIn}
            onChange={(e) => setMoveIn(e.target.value)}
            data-attr="resident-browse-move-in"
            className={`${RESIDENT_HOUSING_INPUT_CLS} hero-search-date-input min-w-0 max-w-full`}
          />
        </ResidentHousingFieldBlock>
        <ResidentHousingFieldBlock label="Move-out date">
          <input
            type="date"
            value={moveOut}
            onChange={(e) => setMoveOut(e.target.value)}
            data-attr="resident-browse-move-out"
            className={`${RESIDENT_HOUSING_INPUT_CLS} hero-search-date-input min-w-0 max-w-full`}
          />
        </ResidentHousingFieldBlock>
        <ResidentHousingFieldBlock label="Room type">
          <Select
            value={roomType}
            onChange={(e) => setRoomType(e.target.value)}
            aria-label="Room type"
            data-attr="resident-browse-room-type"
            className={RESIDENT_HOUSING_INPUT_CLS}
          >
            {RESIDENT_ROOM_TYPE_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </Select>
        </ResidentHousingFieldBlock>
        <ResidentHousingFieldBlock label="Shared bathroom">
          <Select
            value={bathroom}
            onChange={(e) => setBathroom(e.target.value)}
            aria-label="Shared bathroom"
            data-attr="resident-browse-bathroom"
            className={RESIDENT_HOUSING_INPUT_CLS}
          >
            {RESIDENT_BATHROOM_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.id === "any"
                  ? "Any setup"
                  : opt.id === "private"
                    ? "Private bath"
                    : `Shared · ${opt.label}`}
              </option>
            ))}
          </Select>
        </ResidentHousingFieldBlock>
        <ResidentHousingFieldBlock label={`Max budget · ${budgetLabel}`} className="sm:col-span-2">
          <input
            type="range"
            min={RESIDENT_HOUSING_BUDGET_MIN}
            max={RESIDENT_HOUSING_BUDGET_MAX}
            step={RESIDENT_HOUSING_BUDGET_STEP}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            aria-label="Maximum monthly budget"
            data-attr="resident-browse-budget"
            className="mt-3 h-2 w-full cursor-pointer accent-primary"
          />
        </ResidentHousingFieldBlock>
      </div>
      {activeCount > 0 ? (
        <button
          type="button"
          onClick={onClear}
          data-attr="resident-browse-clear-filters"
          className="text-xs font-semibold text-primary hover:underline"
        >
          Clear filters ({activeCount})
        </button>
      ) : null}
    </div>
  );
}

function BrowseFilterPanel({
  sort,
  setSort,
  moveIn,
  setMoveIn,
  moveOut,
  setMoveOut,
  budget,
  setBudget,
  bathroom,
  setBathroom,
  roomType,
  setRoomType,
  activeCount,
  onClear,
  onApplyChatFilters,
}: {
  sort: BrowseSortId;
  setSort: (v: BrowseSortId) => void;
  moveIn: string;
  setMoveIn: (v: string) => void;
  moveOut: string;
  setMoveOut: (v: string) => void;
  budget: number;
  setBudget: (v: number) => void;
  bathroom: string;
  setBathroom: (v: string) => void;
  roomType: string;
  setRoomType: (v: string) => void;
  activeCount: number;
  onClear: () => void;
  onApplyChatFilters: (filters: HousingChatAppliedFilters) => void;
}) {
  return (
    <div className="min-w-0 max-w-full space-y-5 overflow-x-hidden sm:space-y-6">
      <section className="min-w-0 space-y-2 rounded-2xl border border-border/50 bg-accent/20 p-3.5 sm:p-4">
        <ResidentHousingFieldBlock label="Sort">
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as BrowseSortId)}
            aria-label="Sort homes"
            data-attr="resident-browse-sort"
            className={`${RESIDENT_HOUSING_INPUT_CLS} min-w-0 max-w-full`}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </Select>
        </ResidentHousingFieldBlock>
      </section>

      <section className="min-w-0 space-y-2 rounded-2xl border border-border/50 bg-card p-3.5 sm:p-4">
        <ResidentHousingChat
          onApplyFilters={onApplyChatFilters}
          title="What would you like in your next home?"
          subtitle="Describe the type of home you want: room setup, budget, neighborhood, or move-in dates."
          placeholder="e.g. private bath under $1,800 in Capitol Hill, moving in September"
          showMatchListings={false}
        />
      </section>

      <section className="min-w-0 space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Refine search</p>
        <BrowseManualFilters
        moveIn={moveIn}
        setMoveIn={setMoveIn}
        moveOut={moveOut}
        setMoveOut={setMoveOut}
        budget={budget}
        setBudget={setBudget}
        bathroom={bathroom}
        setBathroom={setBathroom}
        roomType={roomType}
        setRoomType={setRoomType}
        activeCount={activeCount}
        onClear={onClear}
        />
      </section>
    </div>
  );
}

export function ResidentHousingBrowse({ propertyIds }: { propertyIds?: string[] } = {}) {
  const { listings, loading, occupancyReady } = usePublicListings();
  const scopedIds = useMemo(
    () => (propertyIds && propertyIds.length > 0 ? propertyIds : null),
    [propertyIds],
  );
  const [sort, setSort] = useState<BrowseSortId>("price-asc");
  const [moveIn, setMoveIn] = useState("");
  const [moveOut, setMoveOut] = useState("");
  const [budget, setBudget] = useState(RESIDENT_HOUSING_BUDGET_MAX);
  const [bathroom, setBathroom] = useState("any");
  const [roomType, setRoomType] = useState("any");
  const [neighborhood, setNeighborhood] = useState<string | undefined>(undefined);

  const budgetActive = budget < RESIDENT_HOUSING_BUDGET_MAX;

  const activeFilterCount = [
    moveIn.trim().length > 0,
    moveOut.trim().length > 0,
    budgetActive,
    bathroom !== "any",
    roomType !== "any",
    Boolean(neighborhood),
  ].filter(Boolean).length;

  const cards = useMemo(
    () =>
      buildPropertyBrowseCards(listings, {
        sort,
        filters: {
          maxBudgetNum: budgetActive ? budget : null,
          bathroom,
          bedroom: roomType,
          moveIn,
          moveOut,
          neighborhood,
          propertyIds: scopedIds,
        },
      }),
    [listings, sort, budgetActive, budget, bathroom, roomType, moveIn, moveOut, neighborhood, scopedIds, occupancyReady],
  );

  function applyChatFilters(applied: HousingChatAppliedFilters) {
    setMoveIn(applied.moveIn ?? "");
    setMoveOut(applied.moveOut ?? "");
    setBudget(typeof applied.maxBudget === "number" ? clampBudget(applied.maxBudget) : RESIDENT_HOUSING_BUDGET_MAX);
    setRoomType(applied.bedroom ?? "any");
    setBathroom(applied.bathroom ?? "any");
    setNeighborhood(applied.neighborhood);
  }

  function clearFilters() {
    setMoveIn("");
    setMoveOut("");
    setBudget(RESIDENT_HOUSING_BUDGET_MAX);
    setBathroom("any");
    setRoomType("any");
    setNeighborhood(undefined);
    setSort("price-asc");
  }

  const filterActiveCount = portalFilterActiveCount([
    sort !== "price-asc" ? sort : "",
    moveIn,
    moveOut,
    budgetActive,
    bathroom !== "any" ? bathroom : "",
    roomType !== "any" ? roomType : "",
    neighborhood,
  ]);

  return (
    <div className="w-full">
      {scopedIds ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-3">
          <p className="text-sm font-semibold text-foreground">
            Showing {cards.length} home{cards.length === 1 ? "" : "s"} shared with you
          </p>
          <a
            href="/rent/browse"
            data-attr="resident-browse-view-all"
            className="text-xs font-semibold text-primary hover:opacity-90"
          >
            View all homes →
          </a>
        </div>
      ) : null}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 sm:mb-8">
        <p className="text-sm font-semibold text-foreground">
          {loading ? "Loading homes…" : `${cards.length} homes available`}
        </p>
        <PortalFilterSortSheet
          activeCount={filterActiveCount}
          className="shrink-0"
          dataAttr="resident-browse-filter-open"
          onReset={clearFilters}
          compactPanel={false}
          panelSizeClassName={PORTAL_FILTER_BROWSE_PANEL_CLASS}
          mobileSheetClassName={PORTAL_FILTER_BROWSE_MOBILE_SHEET_CLASS}
          /* The only filter sheet tall enough (82dvh) that raising it would push its top
             off screen — it stays bottom-anchored, and is stationary either way. */
          mobileSheetFillsViewport
          mobileFlushBody={false}
          desktopPresentation="panel"
          mobileFooter={(close) => (
            <Button
              type="button"
              variant="primary"
              className="w-full"
              data-attr="resident-browse-filter-apply"
              onClick={close}
            >
              Show {loading ? "homes" : `${cards.length} home${cards.length === 1 ? "" : "s"}`}
            </Button>
          )}
        >
          <BrowseFilterPanel
            sort={sort}
            setSort={setSort}
            moveIn={moveIn}
            setMoveIn={setMoveIn}
            moveOut={moveOut}
            setMoveOut={setMoveOut}
            budget={budget}
            setBudget={setBudget}
            bathroom={bathroom}
            setBathroom={setBathroom}
            roomType={roomType}
            setRoomType={setRoomType}
            activeCount={activeFilterCount}
            onClear={clearFilters}
            onApplyChatFilters={applyChatFilters}
          />
        </PortalFilterSortSheet>
      </div>

      {loading ? (
        <BrowseSkeleton />
      ) : cards.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 px-6 py-16 text-center">
          <p className="text-base font-semibold text-foreground">No homes match right now</p>
          <p className="mt-2 text-sm text-muted">
            {activeFilterCount > 0
              ? "Try adjusting your filters. New listings are added as managers publish."
              : "Check back soon. Managers add listings as they go live."}
          </p>
          {activeFilterCount > 0 ? (
            <button
              type="button"
              onClick={clearFilters}
              data-attr="resident-browse-clear-filters"
              className="mt-4 text-sm font-semibold text-primary hover:underline"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="lg:hidden">
            <HousingBrowseSwipeStack cards={cards} />
          </div>
          <div className="hidden pb-8 lg:block">
            <HousingBrowseCarousel cards={cards} />
          </div>
        </>
      )}
    </div>
  );
}
