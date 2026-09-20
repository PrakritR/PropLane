"use client";

import Image from "next/image";
import Link from "next/link";
import { Heart, Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
  RESIDENT_BATHROOM_OPTIONS,
  RESIDENT_HOUSING_BUDGET_MAX,
  RESIDENT_HOUSING_BUDGET_MIN,
  RESIDENT_HOUSING_BUDGET_STEP,
  RESIDENT_HOUSING_INPUT_CLS,
  RESIDENT_ROOM_TYPE_OPTIONS,
  ResidentHousingChat,
  type HousingChatAppliedFilters,
} from "@/components/marketing/resident-listing-search";
import { usePublicListings } from "@/hooks/use-public-listings";
import {
  buildPropertyBrowseCards,
  filterRoomListings,
  demoOnlyBrowseCardPlaceholderImage,
  type BrowseSortId,
  type PropertyBrowseCard,
  browseCardMatchesQuery,
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
import {
  BrowseBudgetRange,
  formatBudgetChipLabel,
  formatBudgetRangeLabel,
} from "@/components/marketing/browse-budget-range";
import { SignedOutOnly } from "@/components/marketing/signed-out-only";
import { residentCreateAccountHref } from "@/lib/resident-public-nav";

const SORT_OPTIONS: { id: BrowseSortId; label: string }[] = [
  { id: "price-asc", label: "Price · low to high" },
  { id: "price-desc", label: "Price · high to low" },
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
  if (card.pricePeriod === "day") return "/day";
  if (card.pricePeriod === "week") return "/week";
  return "/mo";
}

function formatBaths(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Keeps card rows aligned when a listing has no neighborhood. */
function browseCardNeighborhoodLine(card: PropertyBrowseCard): string {
  return card.neighborhood.trim() || " ";
}

function formatMoveInChip(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return `Move in ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

const GRID_CLASS = "grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4";

function BrowseSkeleton() {
  return (
    <div className={GRID_CLASS} aria-hidden>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="aspect-[3/2] w-full animate-pulse bg-accent/30" />
          <div className="space-y-2 p-3.5">
            <div className="h-5 w-2/5 animate-pulse rounded bg-accent/40" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-accent/30" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-accent/30" />
          </div>
        </div>
      ))}
    </div>
  );
}

function AvailabilityPill({ card }: { card: PropertyBrowseCard }) {
  const tone =
    card.availabilityKind === "now"
      ? "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
      : card.availabilityKind === "later"
        ? "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]"
        : "bg-card text-muted";
  const raw = card.availabilityLabel.trim();
  const label = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
  if (!label) return null;
  return (
    <span
      className={`absolute left-2.5 top-2.5 max-w-[calc(100%-4rem)] truncate rounded-full px-2.5 py-1 text-[11px] font-bold shadow-sm ${tone}`}
      data-attr="resident-browse-card-availability"
    >
      {label}
    </span>
  );
}

function HousingBrowseCard({ card }: { card: PropertyBrowseCard }) {
  const rent = formatRent(card);
  const rangeMax =
    card.rentMaxNumeric !== null && card.headlineRent !== null && card.rentMaxNumeric > card.headlineRent
      ? formatRoomPriceAmount(card.rentMaxNumeric)
      : null;
  const resolvedImageUrl =
    card.imageUrl || (isDemoModeActive() ? demoOnlyBrowseCardPlaceholderImage(card.propertyId) : "");
  const isDataUrl = resolvedImageUrl.startsWith("data:");
  const hasPhoto = Boolean(resolvedImageUrl);
  const facts = [
    `${card.roomCount} room${card.roomCount === 1 ? "" : "s"}`,
    card.bathCount > 0 ? `${formatBaths(card.bathCount)} ba` : null,
    card.petFriendly ? "Pets OK" : card.bathHint || null,
  ].filter((f): f is string => Boolean(f));
  const dotCount = Math.min(5, card.photoUrls.length);

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[var(--shadow-card-hover)]">
      <Link
        href={`/rent/listings/${encodeURIComponent(card.propertyId)}`}
        data-attr="resident-browse-listing-card"
        className="flex flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <div className="relative aspect-[3/2] w-full overflow-hidden bg-accent/20">
          {hasPhoto ? (
            <Image
              src={resolvedImageUrl}
              alt=""
              fill
              className="object-cover transition duration-500 group-hover:scale-[1.03]"
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, (max-width: 1280px) 33vw, 320px"
              unoptimized={isDataUrl}
            />
          ) : (
            <NoImagePlaceholder variant="compact" />
          )}
          <AvailabilityPill card={card} />
          {dotCount > 1 ? (
            <span className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center gap-1" aria-hidden>
              {Array.from({ length: dotCount }, (_, i) => (
                <i key={i} className={`h-1.5 w-1.5 rounded-full ${i === 0 ? "bg-white" : "bg-white/55"}`} />
              ))}
            </span>
          ) : null}
        </div>
        <div className="flex flex-1 flex-col p-3.5">
          <p className="text-lg font-bold tracking-tight text-foreground">
            {rent}
            {rangeMax ? <span className="text-sm font-semibold text-muted"> – {rangeMax}</span> : null}
            <span className="ml-1 text-xs font-medium text-muted">{periodSuffix(card)}</span>
          </p>
          <p className="mt-0.5 text-[13px] font-medium text-foreground" data-attr="resident-browse-card-facts">
            {facts.join(" · ")}
          </p>
          <p className="mt-1.5 line-clamp-1 text-sm font-semibold text-foreground">{card.headlineAddress}</p>
          <p className="line-clamp-1 text-xs text-muted">{browseCardNeighborhoodLine(card)}</p>
        </div>
        <span className="sr-only">
          {card.headlineAddress}, {card.neighborhood}, {rent}
          {card.pricePeriod === "day" ? " per day" : card.pricePeriod === "week" ? " per week" : " per month"}
        </span>
      </Link>
      <SignedOutOnly>
        <Link
          href={residentCreateAccountHref()}
          aria-label="Save this home"
          data-attr="resident-browse-save"
          className="absolute right-2.5 top-2.5 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card/95 text-foreground shadow-sm transition hover:border-primary/40 hover:text-primary"
        >
          <Heart className="h-4 w-4" strokeWidth={2} aria-hidden />
        </Link>
      </SignedOutOnly>
    </article>
  );
}

/**
 * Every section of the Filters sheet is one bold label with its control — beside
 * it for a single field, under it for a block like the budget range — and a
 * hairline between sections. Nothing explanatory under any label.
 */
function FilterSection({
  label,
  aside,
  children,
  inline = false,
}: {
  label: string;
  /** A live readout on the label row (the budget range's "$500 – $1,500"). */
  aside?: React.ReactNode;
  children: React.ReactNode;
  /** The control sits on the label row (a Select, a date, a switch). */
  inline?: boolean;
}) {
  return (
    <section className="border-b border-border/60 py-4 last:border-b-0 sm:py-5">
      {inline ? (
        <div className="flex min-w-0 items-center justify-between gap-4">
          <span className="shrink-0 text-[15px] font-bold text-foreground">{label}</span>
          <div className="flex min-w-0 max-w-[60%] justify-end">{children}</div>
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[15px] font-bold text-foreground">{label}</span>
            {aside}
          </div>
          <div className="mt-3">{children}</div>
        </>
      )}
    </section>
  );
}

const FILTER_CONTROL_CLS = `${RESIDENT_HOUSING_INPUT_CLS} min-h-[44px] w-[12rem] max-w-full`;
const FILTER_PAIR_CONTROL_CLS = `${RESIDENT_HOUSING_INPUT_CLS} min-h-[44px] w-full`;

/** Two label + control pairs sharing one section row (Move-in / Move-out, Room type / Bathroom). */
function FilterPair({
  left,
  right,
}: {
  left: { label: string; control: React.ReactNode };
  right: { label: string; control: React.ReactNode };
}) {
  return (
    <section className="border-b border-border/60 py-4 last:border-b-0 sm:py-5">
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        {[left, right].map((pair) => (
          <div key={pair.label} className="flex min-w-0 flex-col gap-2">
            <span className="text-[15px] font-bold text-foreground">{pair.label}</span>
            {pair.control}
          </div>
        ))}
      </div>
    </section>
  );
}

function BrowseFilterPanel({
  sort,
  setSort,
  moveIn,
  setMoveIn,
  moveOut,
  setMoveOut,
  budgetMin,
  budgetMax,
  setBudget,
  budgetRents,
  bathroom,
  setBathroom,
  roomType,
  setRoomType,
  petsOnly,
  setPetsOnly,
  onApplyChatFilters,
}: {
  sort: BrowseSortId;
  setSort: (v: BrowseSortId) => void;
  moveIn: string;
  setMoveIn: (v: string) => void;
  moveOut: string;
  setMoveOut: (v: string) => void;
  budgetMin: number;
  budgetMax: number;
  setBudget: (next: { min: number; max: number }) => void;
  budgetRents: number[];
  bathroom: string;
  setBathroom: (v: string) => void;
  roomType: string;
  setRoomType: (v: string) => void;
  petsOnly: boolean;
  setPetsOnly: (v: boolean) => void;
  onApplyChatFilters: (filters: HousingChatAppliedFilters) => void;
}) {
  return (
    <div className="min-w-0 max-w-full overflow-x-hidden px-1">
      <FilterSection label="Describe what you want">
        <ResidentHousingChat variant="inline" onApplyFilters={onApplyChatFilters} showMatchListings={false} />
      </FilterSection>

      <FilterSection label="Sort" inline>
        <Select
          value={sort}
          onChange={(e) => setSort(e.target.value as BrowseSortId)}
          aria-label="Sort homes"
          data-attr="resident-browse-sort"
          className={FILTER_CONTROL_CLS}
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </Select>
      </FilterSection>

      <FilterSection label="Monthly budget" aside={<BudgetReadout min={budgetMin} max={budgetMax} />}>
        <BrowseBudgetRange min={budgetMin} max={budgetMax} onChange={setBudget} rents={budgetRents} hideLabel />
      </FilterSection>

      <FilterPair
        left={{
          label: "Move-in",
          control: (
            <input
              type="date"
              value={moveIn}
              onChange={(e) => setMoveIn(e.target.value)}
              aria-label="Move-in date"
              data-attr="resident-browse-move-in"
              className={`${FILTER_PAIR_CONTROL_CLS} hero-search-date-input`}
            />
          ),
        }}
        right={{
          label: "Move-out",
          control: (
            <input
              type="date"
              value={moveOut}
              onChange={(e) => setMoveOut(e.target.value)}
              aria-label="Move-out date"
              data-attr="resident-browse-move-out"
              className={`${FILTER_PAIR_CONTROL_CLS} hero-search-date-input`}
            />
          ),
        }}
      />
      <FilterPair
        left={{
          label: "Room type",
          control: (
            <Select
              value={roomType}
              onChange={(e) => setRoomType(e.target.value)}
              aria-label="Room type"
              data-attr="resident-browse-room-type"
              className={FILTER_PAIR_CONTROL_CLS}
            >
              {RESIDENT_ROOM_TYPE_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </Select>
          ),
        }}
        right={{
          label: "Bathroom",
          control: (
            <Select
              value={bathroom}
              onChange={(e) => setBathroom(e.target.value)}
              aria-label="Bathroom"
              data-attr="resident-browse-bathroom"
              className={FILTER_PAIR_CONTROL_CLS}
            >
              {RESIDENT_BATHROOM_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.id === "any" ? "Any setup" : opt.id === "private" ? "Private bath" : `Shared · ${opt.label}`}
                </option>
              ))}
            </Select>
          ),
        }}
      />
      <FilterSection label="Pets allowed" inline>
        <label className="relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center">
          <input
            type="checkbox"
            role="switch"
            checked={petsOnly}
            onChange={(e) => setPetsOnly(e.target.checked)}
            aria-label="Only homes that allow pets"
            data-attr="resident-browse-pets"
            className="peer sr-only"
          />
          <span className="absolute inset-0 rounded-full bg-border transition peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40" />
          <span className="absolute left-1 h-5 w-5 rounded-full bg-white shadow-sm transition peer-checked:translate-x-5" />
        </label>
      </FilterSection>
    </div>
  );
}

function BudgetReadout({ min, max }: { min: number; max: number }) {
  return (
    <span className="text-sm font-bold tabular-nums text-foreground" aria-live="polite">
      {formatBudgetRangeLabel(min, max)}
    </span>
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
  const [budgetMin, setBudgetMin] = useState(RESIDENT_HOUSING_BUDGET_MIN);
  const [budgetMax, setBudgetMax] = useState(RESIDENT_HOUSING_BUDGET_MAX);
  const [bathroom, setBathroom] = useState("any");
  const [roomType, setRoomType] = useState("any");
  const [petsOnly, setPetsOnly] = useState(false);
  const [neighborhood, setNeighborhood] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");

  const budgetMinActive = budgetMin > RESIDENT_HOUSING_BUDGET_MIN;
  const budgetMaxActive = budgetMax < RESIDENT_HOUSING_BUDGET_MAX;

  const activeFilterCount = [
    moveIn.trim().length > 0,
    moveOut.trim().length > 0,
    budgetMinActive || budgetMaxActive,
    bathroom !== "any",
    roomType !== "any",
    petsOnly,
    Boolean(neighborhood),
  ].filter(Boolean).length;

  const budgetRents = useMemo(
    () =>
      filterRoomListings(
        scopedIds?.length ? listings.filter((property) => scopedIds.includes(property.id)) : listings,
        { zipRaw: "", radiusMiles: 50, maxBudgetNum: null, bathroom: "any" },
      )
        .map((c) => c.rentNumeric)
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n)),
    // `occupancyReady` is not read here, but the catalog reads occupancy from
    // storage as it builds rows, so the rents must be rebuilt once it lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listings, scopedIds, occupancyReady],
  );

  const filteredCards = useMemo(
    () =>
      buildPropertyBrowseCards(listings, {
        sort,
        filters: {
          maxBudgetNum: budgetMaxActive ? budgetMax : null,
          minBudgetNum: budgetMinActive ? budgetMin : null,
          bathroom,
          bedroom: roomType,
          moveIn,
          moveOut,
          petFriendly: petsOnly || undefined,
          neighborhood,
          propertyIds: scopedIds,
        },
      }),
    // Same as above: availability comes from occupancy storage, not from props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      listings,
      sort,
      budgetMaxActive,
      budgetMax,
      budgetMinActive,
      budgetMin,
      bathroom,
      roomType,
      moveIn,
      moveOut,
      petsOnly,
      neighborhood,
      scopedIds,
      occupancyReady,
    ],
  );

  const cards = useMemo(() => {
    if (!query.trim()) return filteredCards;
    return filteredCards.filter((c) => browseCardMatchesQuery(c, query));
  }, [filteredCards, query]);

  function applyChatFilters(applied: HousingChatAppliedFilters) {
    setMoveIn(applied.moveIn ?? "");
    setMoveOut(applied.moveOut ?? "");
    setBudgetMin(RESIDENT_HOUSING_BUDGET_MIN);
    setBudgetMax(typeof applied.maxBudget === "number" ? clampBudget(applied.maxBudget) : RESIDENT_HOUSING_BUDGET_MAX);
    setRoomType(applied.bedroom ?? "any");
    setBathroom(applied.bathroom ?? "any");
    setNeighborhood(applied.neighborhood);
  }

  function clearFilters() {
    setMoveIn("");
    setMoveOut("");
    setBudgetMin(RESIDENT_HOUSING_BUDGET_MIN);
    setBudgetMax(RESIDENT_HOUSING_BUDGET_MAX);
    setBathroom("any");
    setRoomType("any");
    setPetsOnly(false);
    setNeighborhood(undefined);
    setSort("price-asc");
  }


  const filterActiveCount = portalFilterActiveCount([
    sort !== "price-asc" ? sort : "",
    moveIn,
    moveOut,
    budgetMinActive || budgetMaxActive,
    bathroom !== "any" ? bathroom : "",
    roomType !== "any" ? roomType : "",
    petsOnly,
    neighborhood,
  ]);

  const roomTypeLabel =
    roomType !== "any" ? (RESIDENT_ROOM_TYPE_OPTIONS.find((o) => o.id === roomType)?.label ?? null) : null;
  const bathroomLabel =
    bathroom === "any"
      ? null
      : bathroom === "private"
        ? "Private bath"
        : `Shared · ${RESIDENT_BATHROOM_OPTIONS.find((o) => o.id === bathroom)?.label ?? bathroom}`;
  const countLabel = loading
    ? "Loading homes…"
    : cards.length === 0
      ? "No homes"
      : `${cards.length} home${cards.length === 1 ? "" : "s"}`;
  const showLabel = `Show ${loading ? "homes" : `${cards.length} home${cards.length === 1 ? "" : "s"}`}`;

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

      <div className="flex items-center gap-2.5">
        <label className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full border border-border bg-card px-4 shadow-sm transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/20">
          <Search className="h-4 w-4 shrink-0 text-muted" strokeWidth={2} aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by neighborhood, city or address"
            aria-label="Search homes by neighborhood, city or address"
            data-attr="resident-browse-search"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted/70 [&::-webkit-search-cancel-button]:appearance-none"
          />
        </label>
        <PortalFilterSortSheet
          activeCount={filterActiveCount}
          className="shrink-0"
          dataAttr="resident-browse-filter-open"
          onReset={clearFilters}
          compactPanel
          title="Filters"
          resetLabel="Clear all"
          panelSizeClassName={PORTAL_FILTER_BROWSE_PANEL_CLASS}
          mobileSheetClassName={PORTAL_FILTER_BROWSE_MOBILE_SHEET_CLASS}
          /* The only filter sheet tall enough (82dvh) that raising it would push its top
             off screen — it stays bottom-anchored, and is stationary either way. */
          mobileSheetFillsViewport
          mobileFlushBody={false}
          desktopPresentation="panel"
          applyLabel={showLabel}
          mobileFooter={(close) => (
            <div className="flex w-full items-center justify-between gap-3">
              <button
                type="button"
                onClick={clearFilters}
                data-attr="resident-browse-clear-filters"
                className="text-sm font-semibold text-foreground underline underline-offset-2"
              >
                Clear all
              </button>
              <Button
                type="button"
                variant="primary"
                className="rounded-full px-6"
                data-attr="resident-browse-filter-apply"
                onClick={close}
              >
                {showLabel}
              </Button>
            </div>
          )}
        >
          <BrowseFilterPanel
            sort={sort}
            setSort={setSort}
            moveIn={moveIn}
            setMoveIn={setMoveIn}
            moveOut={moveOut}
            setMoveOut={setMoveOut}
            budgetMin={budgetMin}
            budgetMax={budgetMax}
            setBudget={({ min, max }) => {
              setBudgetMin(min);
              setBudgetMax(max);
            }}
            budgetRents={budgetRents}
            bathroom={bathroom}
            setBathroom={setBathroom}
            roomType={roomType}
            setRoomType={setRoomType}
            petsOnly={petsOnly}
            setPetsOnly={setPetsOnly}
            onApplyChatFilters={applyChatFilters}
          />
        </PortalFilterSortSheet>
      </div>

      <div className="mb-4 mt-5 flex flex-wrap items-baseline justify-between gap-2 sm:mb-5">
        <p className="text-sm text-foreground" data-attr="resident-browse-count">
          <span className="font-bold">{countLabel}</span>
          {neighborhood ? <span className="text-muted"> · {neighborhood}</span> : null}
        </p>
        {activeFilterCount > 0 ? (
          <button
            type="button"
            onClick={clearFilters}
            data-attr="resident-browse-clear-filters"
            className="text-xs font-semibold text-primary hover:underline"
          >
            Clear filters ({activeFilterCount})
          </button>
        ) : null}
      </div>

      {loading ? (
        <BrowseSkeleton />
      ) : cards.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center">
          <p className="text-base font-semibold text-foreground">No homes match</p>
          {activeFilterCount > 0 || query.trim() ? (
            <p className="mt-1.5 text-sm text-muted">
              {[
                formatBudgetChipLabel(budgetMin, budgetMax),
                moveIn ? formatMoveInChip(moveIn) : null,
                roomTypeLabel,
                bathroomLabel,
                petsOnly ? "Pets OK" : null,
                query.trim() ? `“${query.trim()}”` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {activeFilterCount > 0 || query.trim() ? (
            <Button
              type="button"
              variant="outline"
              className="mt-4 rounded-full"
              data-attr="resident-browse-clear-filters"
              onClick={() => {
                clearFilters();
                setQuery("");
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : (
        <div className={GRID_CLASS} aria-label="Available rental homes">
          {cards.map((card) => (
            <HousingBrowseCard key={card.propertyId} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}
