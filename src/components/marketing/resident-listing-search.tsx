"use client";

import { Sparkles } from "lucide-react";

import Link from "next/link";
import posthog from "posthog-js";
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { usePublicListings } from "@/hooks/use-public-listings";
import { filterRoomListings } from "@/lib/room-listings-catalog";
import { parseUSZip } from "@/lib/listings-search";
import { track } from "@/lib/analytics/track-client";
import { Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const ZIP_RADIUS_MILES = 50;

const BUDGET_MIN = 500;
const BUDGET_MAX = 6500;
const BUDGET_STEP = 100;
const BUDGET_MARKERS = [500, 1500, 2500, 3500, 4500, 5500, 6500] as const;

export const RESIDENT_HOUSING_BUDGET_MIN = BUDGET_MIN;
export const RESIDENT_HOUSING_BUDGET_MAX = BUDGET_MAX;
export const RESIDENT_HOUSING_BUDGET_STEP = BUDGET_STEP;

export const RESIDENT_BATHROOM_OPTIONS = [
  { id: "any", label: "Any" },
  { id: "private", label: "Private bath" },
  { id: "2-share", label: "2-share" },
  { id: "3-share", label: "3-share" },
  { id: "4-share", label: "4-share" },
] as const;

export const RESIDENT_ROOM_TYPE_OPTIONS = [
  { id: "any", label: "Any" },
  { id: "studio", label: "Studio" },
  { id: "1", label: "1 bed" },
  { id: "2", label: "2 beds" },
  { id: "3", label: "3+ beds" },
] as const;

const BATHROOM_OPTIONS = RESIDENT_BATHROOM_OPTIONS;
const BEDROOM_OPTIONS = RESIDENT_ROOM_TYPE_OPTIONS;

export const RESIDENT_HOUSING_INPUT_CLS =
  "min-h-[44px] w-full rounded-xl border border-border/60 bg-[var(--glass-fill)] px-3.5 py-2.5 text-sm text-foreground outline-none transition-all duration-200 placeholder:text-muted/60 focus:border-primary/40 focus:ring-2 focus:ring-primary/25 hover:border-primary/25";

const inputCls = RESIDENT_HOUSING_INPUT_CLS;

function clampBudget(n: number) {
  const stepped = Math.round(n / BUDGET_STEP) * BUDGET_STEP;
  return Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, stepped));
}

export type HousingChatAppliedFilters = {
  moveIn?: string;
  moveOut?: string;
  maxBudget?: number;
  bedroom?: string;
  bathroom?: string;
  zip?: string;
  neighborhood?: string;
};

type ChatAppliedFilters = HousingChatAppliedFilters;

export function ResidentListingSearch() {
  const { listings, loading } = usePublicListings();
  const [moveIn, setMoveIn] = useState("");
  const [moveOut, setMoveOut] = useState("");
  const [budget, setBudget] = useState(BUDGET_MAX);
  const [bathroom, setBathroom] = useState("any");
  const [bedroom, setBedroom] = useState("any");
  const [zipCode, setZipCode] = useState("");

  const budgetActive = budget < BUDGET_MAX;
  const budgetLabel = budgetActive ? `$${budget.toLocaleString()}` : "Any";
  const zipActive = parseUSZip(zipCode) !== null;
  const hasActiveFilter =
    moveIn.trim().length > 0 ||
    budgetActive ||
    bathroom !== "any" ||
    bedroom !== "any" ||
    zipActive;
  const pct = ((clampBudget(budget) - BUDGET_MIN) / (BUDGET_MAX - BUDGET_MIN)) * 100;

  const results = useMemo(() => {
    if (!hasActiveFilter) return [];
    return filterRoomListings(listings, {
      zipRaw: zipCode,
      radiusMiles: ZIP_RADIUS_MILES,
      maxBudgetNum: budgetActive ? budget : null,
      bathroom,
      bedroom,
      moveIn,
      moveOut,
    });
  }, [listings, hasActiveFilter, budgetActive, budget, bathroom, bedroom, zipCode, moveIn, moveOut]);

  function applyChatFilters(applied: ChatAppliedFilters) {
    // Replace the full filter set rather than merging: the search results the chat
    // reports were computed from exactly these fields, so any field NOT mentioned in
    // this query must reset to "Any" — otherwise a leftover filter from an earlier
    // query silently disagrees with the count the assistant just reported.
    setMoveIn(applied.moveIn ?? "");
    setMoveOut(applied.moveOut ?? "");
    setBudget(typeof applied.maxBudget === "number" ? clampBudget(applied.maxBudget) : BUDGET_MAX);
    setBedroom(applied.bedroom ?? "any");
    setBathroom(applied.bathroom ?? "any");
    setZipCode(applied.zip ?? "");
  }

  return (
    <div className="hero-search-panel relative mx-auto w-full max-w-[1060px] overflow-hidden rounded-[1.35rem] px-4 py-6 sm:rounded-[1.75rem] sm:px-8 sm:py-8">
      <ResidentHousingChat onApplyFilters={applyChatFilters} />

      <div className="my-6 h-px w-full bg-border" />

      <div className="space-y-5">
        <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2.2fr)]">
          <FieldBlock label="Move-in date">
            <input
              type="date"
              value={moveIn}
              onChange={(e) => setMoveIn(e.target.value)}
              data-attr="resident-search-move-in"
              className={`${inputCls} hero-search-date-input min-w-0 max-w-full`}
            />
          </FieldBlock>

          <FieldBlock label="Move-out date">
            <input
              type="date"
              value={moveOut}
              onChange={(e) => setMoveOut(e.target.value)}
              data-attr="resident-search-move-out"
              className={`${inputCls} hero-search-date-input min-w-0 max-w-full`}
            />
          </FieldBlock>

          <div className="col-span-2 min-w-0 lg:col-span-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Max budget / mo</span>
              <span className={`text-[13px] font-semibold ${budgetActive ? "text-primary" : "text-muted/60"}`}>
                {budgetLabel}
              </span>
            </div>
            <div className="budget-slider-wrap mt-4 px-0.5" style={{ "--budget-pct": `${pct}%` } as CSSProperties}>
              <input
                type="range"
                min={BUDGET_MIN}
                max={BUDGET_MAX}
                step={BUDGET_STEP}
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
                aria-label="Maximum budget per month"
                data-attr="resident-search-budget"
                className="budget-slider relative z-10 h-7 w-full cursor-pointer appearance-none bg-transparent"
              />
              <div className="mt-1 flex justify-between gap-1 text-[11px] font-medium text-muted/50">
                {BUDGET_MARKERS.map((m) => (
                  <span key={m}>{m === BUDGET_MAX ? "Any" : `$${m.toLocaleString()}`}</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-3">
          <FieldBlock label="Bedrooms">
            <Select
              value={bedroom}
              onChange={(e) => setBedroom(e.target.value)}
              aria-label="Bedrooms"
              data-attr="resident-search-bedrooms"
              className={inputCls}
            >
              {BEDROOM_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </FieldBlock>

          <FieldBlock label="Bathroom type">
            <Select
              value={bathroom}
              onChange={(e) => setBathroom(e.target.value)}
              aria-label="Bathroom type"
              data-attr="resident-search-bathroom"
              className={inputCls}
            >
              {BATHROOM_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </FieldBlock>

          <FieldBlock label="Zip code" className="col-span-2 lg:col-span-1">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="postal-code"
              value={zipCode}
              onChange={(e) => setZipCode(e.target.value.replace(/\D/g, "").slice(0, 5))}
              aria-label="Zip code"
              placeholder="98101"
              data-attr="resident-search-zip"
              className={inputCls}
            />
          </FieldBlock>
        </div>
      </div>

      <div className="my-6 h-px w-full bg-border" />

      {loading ? (
        <p className="text-center text-sm text-muted">Loading available homes…</p>
      ) : !hasActiveFilter ? (
        <p className="text-center text-sm text-muted">Enter a move-in date or budget to see matching listings.</p>
      ) : (
        <div>
          <p className="text-center text-sm font-semibold text-foreground">
            {results.length} listing{results.length === 1 ? "" : "s"} match
          </p>
          {results.length === 0 ? (
            <p className="mt-4 text-center text-[13px] text-muted">No listings match these filters.</p>
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Matching listings">
              {results.map((room) => (
                <li key={room.key}>
                  <Link
                    href={`/rent/listings/${encodeURIComponent(room.propertyId)}`}
                    data-attr="resident-search-listing-card"
                    className="flex h-full flex-col gap-1.5 rounded-2xl border border-border/60 bg-card/50 p-3.5 transition hover:border-primary/25 hover:bg-card [html[data-theme=dark]_&]:border-white/10 [html[data-theme=dark]_&]:bg-white/[0.05]"
                  >
                    <p className="text-sm font-semibold leading-snug text-foreground">{room.headlineAddress}</p>
                    <p className="text-xs text-muted">{room.neighborhood}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full border border-border/60 bg-accent/30 px-2 py-0.5 text-[10px] font-semibold text-muted">
                        {room.priceLabel}
                      </span>
                      <span className="rounded-full border border-border/60 bg-accent/30 px-2 py-0.5 text-[10px] font-semibold text-muted">
                        {room.bathroomHint}
                      </span>
                      <span className="rounded-full border border-border/60 bg-accent/30 px-2 py-0.5 text-[10px] font-semibold text-muted">
                        {room.availabilityLabel}
                      </span>
                      {room.petFriendly && (
                        <span className="rounded-full border border-border/60 bg-accent/30 px-2 py-0.5 text-[10px] font-semibold text-muted">
                          Pet friendly
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

    </div>
  );
}

export function ResidentHousingFieldBlock({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-2${className ? ` ${className}` : ""}`}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</span>
      {children}
    </div>
  );
}

function FieldBlock({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <ResidentHousingFieldBlock label={label} className={className}>
      {children}
    </ResidentHousingFieldBlock>
  );
}

type ChatListing = {
  key: string;
  propertyId: string;
  headlineAddress: string;
  neighborhood: string;
  priceLabel: string;
};

export function ResidentHousingChat({
  onApplyFilters,
  title = "Ask PropLane",
  subtitle = 'Describe what you need, e.g. "2 bed under $2000 in Ballard, moving in August"',
  placeholder,
  showMatchListings = true,
  variant = "card",
}: {
  onApplyFilters: (filters: ChatAppliedFilters) => void;
  title?: string;
  subtitle?: string;
  placeholder?: string;
  showMatchListings?: boolean;
  /**
   * `card` is the titled block the home-search page has always had. `inline`
   * is the one-line form the browse filter sheet leads with: sparkle, input,
   * Ask — no title or sentence above it (PLAN-0914-2124).
   */
  variant?: "card" | "inline";
}) {
  const inline = variant === "inline";
  const resolvedPlaceholder =
    placeholder ??
    (inline ? "e.g. private bath under $1,800 in Fremont" : "Tell us what you're looking for…");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [summary, setSummary] = useState<string | null>(null);
  const [listings, setListings] = useState<ChatListing[]>([]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const message = query.trim();
    if (!message || status === "loading") return;

    setStatus("loading");
    setSummary(null);
    track("housing_search_chat_started", { messageLength: message.length });

    try {
      let sessionId: string | undefined;
      try {
        sessionId = posthog.get_distinct_id();
      } catch {
        sessionId = undefined;
      }
      const res = await fetch("/api/agent/housing-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setStatus("error");
        setSummary(body?.error || "Couldn't understand that. Try mentioning bedrooms, budget, or a neighborhood.");
        return;
      }

      onApplyFilters(body.filters ?? {});
      setListings(body.listings ?? []);
      setStatus("idle");
      setSummary(
        body.matchCount === 0
          ? "No listings match that yet. Filters were still updated."
          : `Found ${body.matchCount} matching home${body.matchCount === 1 ? "" : "s"}. Filters applied.`,
      );
    } catch {
      setStatus("error");
      setSummary("Could not reach the search assistant. Check your connection and try again.");
    }
  }

  if (inline) {
    return (
      <div className="min-w-0 max-w-full">
        <form onSubmit={handleSubmit} className="flex min-w-0 items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Sparkles
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-primary"
              strokeWidth={2}
              aria-hidden
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={resolvedPlaceholder}
              aria-label="Describe the home you're looking for"
              data-attr="resident-search-ai-chat-input"
              className={`${inputCls} min-h-[44px] w-full pl-10`}
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            loading={status === "loading"}
            disabled={status === "loading"}
            data-attr="resident-search-ai-chat-submit"
            className="min-h-[44px] shrink-0 rounded-xl px-4"
          >
            Ask
          </Button>
        </form>
        {summary && (
          <p className={`mt-2 text-sm ${status === "error" ? "text-red-500" : "text-foreground"}`}>{summary}</p>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-muted">{subtitle}</p>
      <form onSubmit={handleSubmit} className="mt-3 flex min-w-0 max-w-full flex-col gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={resolvedPlaceholder}
          aria-label="Describe the home you're looking for"
          data-attr="resident-search-ai-chat-input"
          className={`${inputCls} min-w-0 w-full flex-1`}
        />
        <Button
          type="submit"
          variant="primary"
          loading={status === "loading"}
          disabled={status === "loading" || !query.trim()}
          data-attr="resident-search-ai-chat-submit"
          className="w-full shrink-0 sm:w-auto"
        >
          {status === "loading" ? "Searching…" : "Search"}
        </Button>
      </form>

      {summary && (
        <p className={`mt-3 text-sm ${status === "error" ? "text-red-500" : "text-foreground"}`}>{summary}</p>
      )}

      {showMatchListings && listings.length > 0 && status !== "error" && (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="AI-matched listings">
          {listings.map((room) => (
            <li key={room.key}>
              <Link
                href={`/rent/listings/${encodeURIComponent(room.propertyId)}`}
                data-attr="resident-search-ai-chat-listing-card"
                className="flex flex-col gap-0.5 rounded-xl border border-border/60 bg-card/50 p-3 text-sm transition hover:border-primary/25 hover:bg-card [html[data-theme=dark]_&]:border-white/10 [html[data-theme=dark]_&]:bg-white/[0.05]"
              >
                <span className="font-semibold text-foreground">{room.headlineAddress}</span>
                <span className="text-xs text-muted">
                  {room.neighborhood} · {room.priceLabel}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
