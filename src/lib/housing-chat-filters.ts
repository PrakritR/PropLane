/**
 * The filters `/api/agent/housing-search` returns, and the two pure readings of them the browse page
 * needs: the page state they set (every field, none dropped) and the plain facts the "Understood" row
 * shows. Kept out of the components so both are testable without a DOM.
 */
import { leaseTypeLabel, type LeaseTypeId } from "@/lib/rental-application/lease-terms";

export type HousingChatAppliedFilters = {
  moveIn?: string;
  moveOut?: string;
  maxBudget?: number;
  minBudget?: number;
  bedroom?: string;
  bathroom?: string;
  zip?: string;
  neighborhood?: string;
  petFriendly?: boolean;
  leaseTypes?: LeaseTypeId[];
};

export type BrowseBudgetBounds = { min: number; max: number; step: number };

export type BrowseStateFromChat = {
  moveIn: string;
  moveOut: string;
  budgetMin: number;
  budgetMax: number;
  roomType: string;
  bathroom: string;
  petsOnly: boolean;
  neighborhood: string | undefined;
  leaseTypes: LeaseTypeId[];
};

function clamp(n: number, b: BrowseBudgetBounds): number {
  const stepped = Math.round(n / b.step) * b.step;
  return Math.min(b.max, Math.max(b.min, stepped));
}

/** Every returned field becomes page state; a field the query did not mention resets to "any". */
export function browseStateFromChatFilters(
  applied: HousingChatAppliedFilters,
  bounds: BrowseBudgetBounds,
): BrowseStateFromChat {
  return {
    moveIn: applied.moveIn ?? "",
    moveOut: applied.moveOut ?? "",
    budgetMin: typeof applied.minBudget === "number" ? clamp(applied.minBudget, bounds) : bounds.min,
    budgetMax: typeof applied.maxBudget === "number" ? clamp(applied.maxBudget, bounds) : bounds.max,
    roomType: applied.bedroom ?? "any",
    bathroom: applied.bathroom ?? "any",
    petsOnly: applied.petFriendly === true,
    neighborhood: applied.neighborhood?.trim() || undefined,
    leaseTypes: applied.leaseTypes ?? [],
  };
}

const BEDROOM_LABELS: Record<string, string> = { studio: "Studio", "1": "1 bed", "2": "2 beds", "3": "3+ beds" };

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function dateFact(prefix: string, iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return `${prefix} ${iso}`;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${prefix} ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/** The "Understood" row: what the assistant took from the sentence, as plain facts. */
export function describeChatFilters(applied: HousingChatAppliedFilters, matchCount?: number): string[] {
  const facts: string[] = [];
  if (applied.bathroom) {
    facts.push(applied.bathroom === "private" ? "Private bath" : `Shared · ${applied.bathroom}`);
  }
  if (applied.bedroom) facts.push(BEDROOM_LABELS[applied.bedroom] ?? applied.bedroom);
  const hasMin = typeof applied.minBudget === "number";
  const hasMax = typeof applied.maxBudget === "number";
  if (hasMin && hasMax) facts.push(`${money(applied.minBudget!)} – ${money(applied.maxBudget!)}`);
  else if (hasMax) facts.push(`under ${money(applied.maxBudget!)}`);
  else if (hasMin) facts.push(`${money(applied.minBudget!)}+`);
  if (applied.petFriendly) facts.push("Pets");
  for (const id of applied.leaseTypes ?? []) facts.push(leaseTypeLabel(id));
  if (applied.neighborhood) facts.push(applied.neighborhood);
  if (applied.moveIn) facts.push(dateFact("Move in", applied.moveIn));
  if (applied.moveOut) facts.push(dateFact("Move out", applied.moveOut));
  if (typeof matchCount === "number") facts.push(`${matchCount} home${matchCount === 1 ? "" : "s"}`);
  return facts;
}
