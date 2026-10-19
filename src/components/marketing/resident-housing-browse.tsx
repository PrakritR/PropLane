"use client";

import Image from "next/image";
import Link from "next/link";
import { Heart, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  RESIDENT_BATHROOM_OPTIONS,
  RESIDENT_HOUSING_BUDGET_MAX,
  RESIDENT_HOUSING_BUDGET_MIN,
  RESIDENT_HOUSING_BUDGET_STEP,
  RESIDENT_ROOM_TYPE_OPTIONS,
  ResidentHousingChat,
} from "@/components/marketing/resident-listing-search";
import { browseStateFromChatFilters, type HousingChatAppliedFilters } from "@/lib/housing-chat-filters";
import { LEASE_TYPES, leaseTypeLabel, type LeaseTypeId } from "@/lib/rental-application/lease-terms";
import { usePublicListings } from "@/hooks/use-public-listings";
import {
  buildPropertyBrowseCards,
  demoOnlyBrowseCardPlaceholderImage,
  type BrowseSortId,
  type PropertyBrowseCard,
  browseCardMatchesQuery,
} from "@/lib/room-listings-catalog";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";
import { formatBudgetRangeLabel } from "@/components/marketing/browse-budget-range";
import { SignedOutOnly } from "@/components/marketing/signed-out-only";
import { residentCreateAccountHref, residentSignInHref } from "@/lib/resident-public-nav";
import "@/components/public-site/browse.css";

const SORT_OPTIONS: { id: BrowseSortId; label: string }[] = [
  { id: "price-asc", label: "Price · low to high" },
  { id: "price-desc", label: "Price · high to low" },
  { id: "neighborhood", label: "Neighborhood A–Z" },
  { id: "next-opening", label: "Next opening" },
];

/** The Budget dropdown's steps (the ceiling a renter will pay a month). */
const BUDGET_STEPS = [1000, 1250, 1500, 2000, 2500, 3500] as const;

/** `listingPlaceCategoryId` as the listing stores it; "any" is the unset filter. */
type PlaceKind = "any" | "private_room" | "shared_home" | "entire_home";
const PLACE_KIND_LABELS: Record<Exclude<PlaceKind, "any">, string> = {
  private_room: "Private room",
  shared_home: "Room in a shared home",
  entire_home: "Whole home",
};

const BROWSE_BUDGET_BOUNDS = {
  min: RESIDENT_HOUSING_BUDGET_MIN,
  max: RESIDENT_HOUSING_BUDGET_MAX,
  step: RESIDENT_HOUSING_BUDGET_STEP,
};

function formatRent(card: PropertyBrowseCard): string {
  const display = card.headlineRent ?? card.rentNumeric;
  if (display !== null) return formatRoomPriceAmount(display);
  const stripped = card.priceLabel.replace(/\/month/i, "").replace(/\/day/i, "").trim();
  return stripped || "—";
}

function periodSuffix(card: PropertyBrowseCard): string {
  if (card.pricePeriod === "day") return "/ day";
  if (card.pricePeriod === "week") return "/ week";
  return "/ mo";
}

function formatBaths(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function formatShortDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Available now", "Available Oct 24", or the listing's own wording when it has no dated opening. */
function availabilityText(card: PropertyBrowseCard): string {
  if (card.availabilityKind === "now") return "Available now";
  const date = card.nextOpening ? formatShortDate(card.nextOpening) : null;
  if (date) return `Available ${date}`;
  const raw = card.availabilityLabel.trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
}

function BrowseSkeleton() {
  return (
    <div className="ps-bgrid" aria-hidden data-attr="resident-browse-skeleton">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="ps-card-soft">
          <span className="ps-bskel block aspect-[4/3] w-full" />
          <div className="grid gap-2 p-4">
            <span className="ps-bskel h-6 w-2/5" />
            <span className="ps-bskel h-4 w-3/4" />
            <span className="ps-bskel h-4 w-1/2" />
          </div>
        </div>
      ))}
    </div>
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
  const facts = [
    `${card.roomCount} room${card.roomCount === 1 ? "" : "s"}`,
    card.bathCount > 0 ? `${formatBaths(card.bathCount)} ba` : null,
    card.petFriendly ? "Pets OK" : card.bathHint || null,
    ...card.leaseTypes.map(leaseTypeLabel),
  ].filter((f): f is string => Boolean(f));
  const avail = availabilityText(card);

  return (
    <article className="ps-card-soft ps-bcard">
      <Link
        href={`/rent/listings/${encodeURIComponent(card.propertyId)}`}
        data-attr="resident-browse-listing-card"
        className="ps-bcard-link"
      >
        <div className="ps-bcard-photo">
          {resolvedImageUrl ? (
            <Image
              src={resolvedImageUrl}
              alt=""
              fill
              className="object-cover"
              sizes="(max-width: 640px) 100vw, (max-width: 1100px) 50vw, (max-width: 1400px) 33vw, 25vw"
              unoptimized={isDataUrl}
            />
          ) : (
            <NoImagePlaceholder variant="compact" />
          )}
        </div>
        <div className="ps-bcard-body">
          <p className="ps-figure ps-bcard-price">
            {rent}
            {rangeMax ? `–${rangeMax}` : ""} <small>{periodSuffix(card)}</small>
          </p>
          <p className="ps-bcard-title">{card.headlineAddress}</p>
          <p className="ps-bcard-line">{card.neighborhood.trim() || " "}</p>
          <p className="ps-bcard-line" data-attr="resident-browse-card-facts">
            {facts.join(" · ")}
          </p>
          {avail ? (
            <p
              className="ps-bcard-avail"
              data-attr={card.availabilityKind === "now" ? "resident-browse-card-availability" : "resident-browse-card-next-opening"}
            >
              {avail}
            </p>
          ) : null}
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
          title="Save this home"
          data-attr="resident-browse-save"
          className="ps-bcard-save"
        >
          <Heart className="h-4 w-4" strokeWidth={2} aria-hidden />
        </Link>
      </SignedOutOnly>
    </article>
  );
}

function Cell({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`ps-bf-cell ${className}`}>
      <span className="ps-bf-label">{label}</span>
      {children}
    </label>
  );
}

type FilterModel = {
  budgetMin: number;
  budgetMax: number;
  setBudget: (min: number, max: number) => void;
  moveIn: string;
  setMoveIn: (v: string) => void;
  neighborhood: string | undefined;
  setNeighborhood: (v: string | undefined) => void;
  areaOptions: string[];
  placeKind: PlaceKind;
  setPlaceKind: (v: PlaceKind) => void;
  /** The room types some loaded home actually has; the dropdown is left out when there are none. */
  placeKindOptions: Exclude<PlaceKind, "any">[];
};

/** The four always-visible filters as bare controls: Budget, Move in, Area, Room type. */
function FourFilters({ m, sheet = false }: { m: FilterModel; sheet?: boolean }) {
  const minActive = m.budgetMin > RESIDENT_HOUSING_BUDGET_MIN;
  const maxActive = m.budgetMax < RESIDENT_HOUSING_BUDGET_MAX;
  const onLadder = (BUDGET_STEPS as readonly number[]).includes(m.budgetMax);
  const budgetValue = minActive ? "custom" : !maxActive ? "any" : String(m.budgetMax);
  const budgetOptions: { value: string; label: string }[] = [
    { value: "any", label: "Any" },
    ...BUDGET_STEPS.map((n) => ({ value: String(n), label: `Up to ${formatRoomPriceAmount(n)}` })),
  ];
  if (minActive) {
    budgetOptions.push({ value: "custom", label: formatBudgetRangeLabel(m.budgetMin, m.budgetMax) });
  } else if (maxActive && !onLadder) {
    budgetOptions.push({ value: String(m.budgetMax), label: `Up to ${formatRoomPriceAmount(m.budgetMax)}` });
  }
  const areas = m.neighborhood && !m.areaOptions.includes(m.neighborhood) ? [...m.areaOptions, m.neighborhood] : m.areaOptions;

  const wrap = (label: string, control: ReactNode) =>
    sheet ? (
      <div className="ps-bsheet-sec">
        <label className="grid gap-2">
          <span className="ps-bf-label">{label}</span>
          {control}
        </label>
      </div>
    ) : (
      <Cell label={label}>{control}</Cell>
    );

  return (
    <>
      {wrap(
        "Budget",
        <select
          className="ps-bf-ctl"
          value={budgetValue}
          aria-label="Budget, maximum monthly rent"
          data-attr="resident-browse-budget"
          onChange={(e) => {
            const v = e.target.value;
            if (v === "custom") return;
            m.setBudget(RESIDENT_HOUSING_BUDGET_MIN, v === "any" ? RESIDENT_HOUSING_BUDGET_MAX : Number(v));
          }}
        >
          {budgetOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>,
      )}
      {wrap(
        "Move in by",
        <input
          type="date"
          className="ps-bf-ctl hero-search-date-input"
          value={m.moveIn}
          aria-label="Move in by"
          data-attr="resident-browse-move-in"
          onChange={(e) => m.setMoveIn(e.target.value)}
        />,
      )}
      {wrap(
        "Area",
        <select
          className="ps-bf-ctl"
          value={m.neighborhood ?? "any"}
          aria-label="Area"
          data-attr="resident-browse-area"
          onChange={(e) => m.setNeighborhood(e.target.value === "any" ? undefined : e.target.value)}
        >
          <option value="any">Any</option>
          {areas.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>,
      )}
      {m.placeKindOptions.length > 0
        ? wrap(
            "Room type",
            <select
              className="ps-bf-ctl"
              value={m.placeKind}
              aria-label="Room type"
              data-attr="resident-browse-place-kind"
              onChange={(e) => m.setPlaceKind(e.target.value as PlaceKind)}
            >
              <option value="any">Any</option>
              {m.placeKindOptions.map((id) => (
                <option key={id} value={id}>
                  {PLACE_KIND_LABELS[id]}
                </option>
              ))}
            </select>,
          )
        : null}
    </>
  );
}

type SheetExtras = {
  sort: BrowseSortId;
  setSort: (v: BrowseSortId) => void;
  moveOut: string;
  setMoveOut: (v: string) => void;
  roomType: string;
  setRoomType: (v: string) => void;
  bathroom: string;
  setBathroom: (v: string) => void;
  leaseTypes: LeaseTypeId[];
  setLeaseTypes: (v: LeaseTypeId[]) => void;
  petsOnly: boolean;
  setPetsOnly: (v: boolean) => void;
  onApplyChatFilters: (filters: HousingChatAppliedFilters) => void;
};

/** Bottom sheet on a phone, centered panel on desktop. Controls apply as they change. */
function FiltersSheet({
  onClose,
  model,
  extras,
  countLabel,
  onClear,
  canClear,
}: {
  onClose: () => void;
  model: FilterModel;
  extras: SheetExtras;
  countLabel: string;
  onClear: () => void;
  canClear: boolean;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="ps">
      <div
        className="ps-bsheet-wrap"
        data-attr="resident-browse-filter-sheet"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="ps-bsheet" role="dialog" aria-modal="true" aria-label="Filters">
          <div className="ps-bsheet-head">
            <h2 className="ps-h3">Filters</h2>
            <button type="button" className="ps-bf-text" onClick={onClose} data-attr="resident-browse-filter-close">
              Close
            </button>
          </div>
          <div className="ps-bsheet-body">
            <div className="ps-bsheet-sec">
              <span className="ps-bf-label">Describe what you want</span>
              <ResidentHousingChat variant="inline" onApplyFilters={extras.onApplyChatFilters} showMatchListings={false} />
            </div>
            <FourFilters m={model} sheet />
            <div className="ps-bsheet-sec">
              <label className="grid gap-2">
                <span className="ps-bf-label">Sort</span>
                <select
                  className="ps-bf-ctl"
                  value={extras.sort}
                  aria-label="Sort homes"
                  data-attr="resident-browse-sort"
                  onChange={(e) => extras.setSort(e.target.value as BrowseSortId)}
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="ps-bsheet-sec">
              <label className="grid gap-2">
                <span className="ps-bf-label">Bedrooms</span>
                <select
                  className="ps-bf-ctl"
                  value={extras.roomType}
                  aria-label="Bedrooms"
                  data-attr="resident-browse-room-type"
                  onChange={(e) => extras.setRoomType(e.target.value)}
                >
                  {RESIDENT_ROOM_TYPE_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="ps-bsheet-sec">
              <label className="grid gap-2">
                <span className="ps-bf-label">Bathroom</span>
                <select
                  className="ps-bf-ctl"
                  value={extras.bathroom}
                  aria-label="Bathroom"
                  data-attr="resident-browse-bathroom"
                  onChange={(e) => extras.setBathroom(e.target.value)}
                >
                  {RESIDENT_BATHROOM_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.id === "any" ? "Any setup" : o.id === "private" ? "Private bath" : `Shared · ${o.label}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="ps-bsheet-sec">
              <label className="grid gap-2">
                <span className="ps-bf-label">Move out by</span>
                <input
                  type="date"
                  className="ps-bf-ctl hero-search-date-input"
                  value={extras.moveOut}
                  aria-label="Move-out date"
                  data-attr="resident-browse-move-out"
                  onChange={(e) => extras.setMoveOut(e.target.value)}
                />
              </label>
            </div>
            <div className="ps-bsheet-sec" data-attr="resident-browse-lease-type">
              <span className="ps-bf-label">Lease type</span>
              <div className="ps-bchecks">
                {LEASE_TYPES.map((t) => (
                  <label key={t.id}>
                    <input
                      type="checkbox"
                      checked={extras.leaseTypes.includes(t.id)}
                      onChange={(e) =>
                        extras.setLeaseTypes(
                          e.target.checked ? [...extras.leaseTypes, t.id] : extras.leaseTypes.filter((x) => x !== t.id),
                        )
                      }
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="ps-bsheet-sec">
              <div className="ps-bchecks">
                <label>
                  <input
                    type="checkbox"
                    checked={extras.petsOnly}
                    aria-label="Only homes that allow pets"
                    data-attr="resident-browse-pets"
                    onChange={(e) => extras.setPetsOnly(e.target.checked)}
                  />
                  Pets allowed
                </label>
              </div>
            </div>
          </div>
          <div className="ps-bsheet-foot">
            <button
              type="button"
              className="ps-bf-text"
              onClick={onClear}
              disabled={!canClear}
              style={canClear ? undefined : { opacity: 0.4, cursor: "default" }}
              data-attr="resident-browse-clear-filters"
            >
              Clear
            </button>
            <button type="button" className="ps-btn ps-btn-blue" onClick={onClose} data-attr="resident-browse-filter-apply">
              {countLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ResidentHousingBrowse({
  propertyIds,
  heading = "Find a home",
}: {
  propertyIds?: string[];
  /** The page title; the home count sits on its right. */
  heading?: string;
} = {}) {
  const { listings: loadedListings, loading, occupancyReady, error, retry } = usePublicListings();
  /*
   * A stub row (an id and a title, no rent or rooms) cannot be drawn as a card and the catalog
   * throws reading its rent, which blanked the whole page. Only a row that carries a rent label
   * is browsable.
   */
  const listings = useMemo(
    () => loadedListings.filter((p) => typeof p.rentLabel === "string"),
    [loadedListings],
  );
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
  const [leaseTypes, setLeaseTypes] = useState<LeaseTypeId[]>([]);
  const [neighborhood, setNeighborhood] = useState<string | undefined>(undefined);
  const [placeKind, setPlaceKind] = useState<PlaceKind>("any");
  const [query, setQuery] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);

  const budgetMinActive = budgetMin > RESIDENT_HOUSING_BUDGET_MIN;
  const budgetMaxActive = budgetMax < RESIDENT_HOUSING_BUDGET_MAX;

  /** Each property's own rental model (rent by the room, or the whole home). */
  const placeKindById = useMemo(() => {
    const map = new Map<string, PlaceKind>();
    for (const p of listings) {
      const raw = p.listingSubmission?.listingPlaceCategoryId;
      if (raw === "private_room" || raw === "shared_home" || raw === "entire_home") map.set(p.id, raw);
    }
    return map;
  }, [listings]);
  const placeKindOptions = useMemo(
    () => (["private_room", "shared_home", "entire_home"] as const).filter((k) => [...placeKindById.values()].includes(k)),
    [placeKindById],
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
          leaseTypes,
          neighborhood,
          propertyIds: scopedIds,
        },
      }),
    // Availability comes from occupancy storage, not from props, so it rebuilds once that lands.
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
      leaseTypes,
      neighborhood,
      scopedIds,
      occupancyReady,
    ],
  );

  const cards = useMemo(() => {
    let next = filteredCards;
    if (placeKind !== "any") next = next.filter((c) => placeKindById.get(c.propertyId) === placeKind);
    if (query.trim()) next = next.filter((c) => browseCardMatchesQuery(c, query));
    return next;
  }, [filteredCards, placeKind, placeKindById, query]);

  /** Areas of every home in scope, before any filter narrows them. */
  const areaOptions = useMemo(() => {
    const all = buildPropertyBrowseCards(listings, {
      sort: "neighborhood",
      filters: { propertyIds: scopedIds },
    });
    return Array.from(new Set(all.map((c) => c.neighborhood.trim()).filter(Boolean)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listings, scopedIds, occupancyReady]);

  function applyChatFilters(applied: HousingChatAppliedFilters) {
    const next = browseStateFromChatFilters(applied, BROWSE_BUDGET_BOUNDS);
    setMoveIn(next.moveIn);
    setMoveOut(next.moveOut);
    setBudgetMin(next.budgetMin);
    setBudgetMax(next.budgetMax);
    setRoomType(next.roomType);
    setBathroom(next.bathroom);
    setPetsOnly(next.petsOnly);
    setLeaseTypes(next.leaseTypes);
    setNeighborhood(next.neighborhood);
    setPlaceKind("any");
  }

  function clearFilters() {
    setMoveIn("");
    setMoveOut("");
    setBudgetMin(RESIDENT_HOUSING_BUDGET_MIN);
    setBudgetMax(RESIDENT_HOUSING_BUDGET_MAX);
    setBathroom("any");
    setRoomType("any");
    setPetsOnly(false);
    setLeaseTypes([]);
    setNeighborhood(undefined);
    setPlaceKind("any");
    setSort("price-asc");
    setQuery("");
  }

  const activeFilterCount = [
    sort !== "price-asc",
    moveIn.trim().length > 0,
    moveOut.trim().length > 0,
    budgetMinActive || budgetMaxActive,
    bathroom !== "any",
    roomType !== "any",
    petsOnly,
    leaseTypes.length > 0,
    Boolean(neighborhood),
    placeKind !== "any",
    query.trim().length > 0,
  ].filter(Boolean).length;

  const model: FilterModel = {
    budgetMin,
    budgetMax,
    setBudget: (min, max) => {
      setBudgetMin(min);
      setBudgetMax(max);
    },
    moveIn,
    setMoveIn,
    neighborhood,
    setNeighborhood,
    areaOptions,
    placeKind,
    setPlaceKind,
    placeKindOptions,
  };

  const homesLabel = loading ? "" : `${cards.length} home${cards.length === 1 ? "" : "s"}`;
  const searchInput = (
    <>
      <Search className="h-4 w-4" strokeWidth={2} aria-hidden />
      <input
        type="search"
        className="ps-bf-ctl"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Neighborhood, city or address"
        aria-label="Search homes by neighborhood, city or address"
        data-attr="resident-browse-search"
      />
    </>
  );

  return (
    <div className="w-full">
      <header className="ps-browse-head">
        <h1 className="ps-h1 ps-browse-h1">{heading}</h1>
        <p className="ps-figure ps-browse-count" data-attr="resident-browse-count" aria-live="polite">
          {homesLabel}
        </p>
      </header>

      {scopedIds ? (
        <div className="ps-browse-scope">
          <p>
            Showing {cards.length} home{cards.length === 1 ? "" : "s"} shared with you
          </p>
          <a href="/rent/browse" data-attr="resident-browse-view-all" className="ps-link">
            View all homes →
          </a>
        </div>
      ) : null}

      <div className={`ps-bf ps-bf-desktop${placeKindOptions.length > 0 ? "" : " ps-bf-3"}`} role="search">
        <FourFilters m={model} />
        <div className="ps-bf-cell ps-bf-search">{searchInput}</div>
        <div className="ps-bf-tools">
          <button type="button" className="ps-bf-text" onClick={() => setSheetOpen(true)} data-attr="resident-browse-filter-open-desktop">
            More
          </button>
          {activeFilterCount > 0 ? (
            <button type="button" className="ps-bf-text" onClick={clearFilters} data-attr="resident-browse-clear-filters">
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <div className="ps-bf-phone">
        <label className="ps-bf-search">{searchInput}</label>
        <div className="ps-bf-phone-row">
          <button
            type="button"
            className="ps-btn ps-btn-line"
            onClick={() => setSheetOpen(true)}
            data-attr="resident-browse-filter-open"
          >
            Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
          </button>
          {activeFilterCount > 0 ? (
            <button type="button" className="ps-bf-text" onClick={clearFilters} data-attr="resident-browse-clear-filters">
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {sheetOpen ? (
        <FiltersSheet
          onClose={() => setSheetOpen(false)}
          model={model}
          extras={{
            sort,
            setSort,
            moveOut,
            setMoveOut,
            roomType,
            setRoomType,
            bathroom,
            setBathroom,
            leaseTypes,
            setLeaseTypes,
            petsOnly,
            setPetsOnly,
            onApplyChatFilters: applyChatFilters,
          }}
          countLabel={loading ? "Show homes" : `Show ${cards.length} home${cards.length === 1 ? "" : "s"}`}
          onClear={clearFilters}
          canClear={activeFilterCount > 0}
        />
      ) : null}

      {error && listings.length === 0 ? (
        <div className="ps-bempty" role="alert">
          <p className="ps-h3">Homes did not load.</p>
          <button type="button" className="ps-btn ps-btn-line" onClick={retry} data-attr="resident-browse-retry">
            Retry
          </button>
        </div>
      ) : loading ? (
        <BrowseSkeleton />
      ) : cards.length === 0 ? (
        <div className="ps-bempty">
          <p className="ps-h3">No homes match</p>
          {activeFilterCount > 0 ? (
            <button type="button" className="ps-btn ps-btn-line" data-attr="resident-browse-clear-filters" onClick={clearFilters}>
              Clear filters
            </button>
          ) : null}
        </div>
      ) : (
        <div className="ps-bgrid" aria-label="Available rental homes">
          {cards.map((card) => (
            <HousingBrowseCard key={card.propertyId} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The one-row "Ready to apply?" band under the grid. */
export function BrowseApplyBand() {
  return (
    <section className="ps-bband" aria-label="Create an account to apply">
      <h2 className="ps-h3">Ready to apply?</h2>
      <div className="ps-bband-act">
        <Link href={residentSignInHref()} data-attr="resident-browse-sign-in" className="ps-link">
          Sign in
        </Link>
        <Link href={residentCreateAccountHref()} data-attr="resident-browse-get-started" className="ps-btn ps-btn-blue">
          Get started
        </Link>
      </div>
    </section>
  );
}
