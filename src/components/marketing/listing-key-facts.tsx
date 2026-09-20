import type { ComponentType } from "react";
import { Bath, BedDouble, CalendarDays, DollarSign, PawPrint } from "lucide-react";
import type { MockProperty } from "@/data/types";
import type { ListingRichContent } from "@/data/listing-rich-content";
import { earliestRoomOpening, roomAvailabilityTone } from "@/lib/room-availability-style";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import type { ListingBathroomRow, ListingSharedRow } from "@/data/listing-rich-content";

/**
 * The rich-content builder emits one placeholder row when a listing has no
 * bathrooms / shared spaces, so the old tables never rendered empty. The new
 * page says so in words instead, and the tiles must not count it.
 */
export function isListingFallbackBathroom(row: Pick<ListingBathroomRow, "id">): boolean {
  return row.id === "b-fallback";
}
export function isListingPlaceholderSharedSpace(row: Pick<ListingSharedRow, "id">): boolean {
  return row.id === "shared-placeholder";
}

/** "$1050–$1300/mo" → "$1,050–$1,300/mo": every dollar amount in a label, through the one money formatter. */
export function formatMoneyInLabel(label: string): string {
  return label.replace(/\$(\d[\d,]*(?:\.\d+)?)/g, (_m, num: string) => {
    const n = Number(num.replace(/,/g, ""));
    return Number.isFinite(n) ? formatRoomPriceAmount(n) : `$${num}`;
  });
}

/**
 * The five numbers a renter scans for before reading a word (PLAN-0914-2124):
 * rent, rooms, baths, when, pets. Every value is DERIVED from content the
 * listing already carries — nothing here is stored, typed by hand, or guessed
 * from prose — and a tile whose value is genuinely unknown is omitted rather
 * than shown as a dash.
 */
export type ListingKeyFactId = "rent" | "rooms" | "baths" | "availability" | "pets";

export type ListingKeyFact = {
  id: ListingKeyFactId;
  /** The bold number or word. */
  value: string;
  /** The unit or qualifier under it — a label, never a sentence. */
  label?: string;
};

/**
 * "base rent $1,000–$1,300/mo" → "$1,000 – $1,300". The range label is built
 * for a floating chip today; the tile carries the unit in its own label line.
 */
export function listingRentTileValue(rich: Pick<ListingRichContent, "priceRangeLabel" | "startingRentLabel">): string | null {
  const strip = (s: string) =>
    formatMoneyInLabel(s)
      .replace(/^\s*base rent\s*/i, "")
      .replace(/\s*\/\s*(mo|month|day|week)\s*$/i, "")
      .replace(/\s*[–-]\s*/g, " – ")
      .trim();
  const range = strip(rich.priceRangeLabel ?? "");
  if (range && range !== "—" && /\d/.test(range)) return range;
  const start = strip(rich.startingRentLabel ?? "");
  if (start && start !== "—" && /\d/.test(start)) return start;
  return null;
}

function rentPeriodLabel(rich: Pick<ListingRichContent, "priceRangeLabel" | "startingRentLabel">): string {
  const source = `${rich.priceRangeLabel ?? ""} ${rich.startingRentLabel ?? ""}`.toLowerCase();
  if (/\/\s*day\b/.test(source)) return "base rent / day";
  if (/\/\s*week\b/.test(source)) return "base rent / week";
  return "base rent / mo";
}

export function deriveListingKeyFacts(
  rich: ListingRichContent,
  property: Pick<MockProperty, "beds" | "baths" | "petFriendly">,
): ListingKeyFact[] {
  const facts: ListingKeyFact[] = [];

  const rent = listingRentTileValue(rich);
  if (rent) facts.push({ id: "rent", value: rent, label: rentPeriodLabel(rich) });

  const rooms = rich.floorPlans.flatMap((f) => f.rooms);
  const roomCount = rooms.length > 0 ? rooms.length : property.beds > 0 ? property.beds : 0;
  if (roomCount > 0) {
    const availableNow = rooms.filter((r) => roomAvailabilityTone(r.availability) === "available").length;
    facts.push({
      id: "rooms",
      value: `${roomCount} room${roomCount === 1 ? "" : "s"}`,
      label: rooms.length > 0 ? `${availableNow} available now` : undefined,
    });
  }

  const bathrooms = rich.bathrooms.filter((b) => !isListingFallbackBathroom(b));
  const bathCount = bathrooms.length > 0 ? bathrooms.length : property.baths > 0 ? property.baths : 0;
  if (bathCount > 0) {
    const privateCount = bathrooms.filter((b) => b.modal.usedByRoomNames.length === 1).length;
    facts.push({
      id: "baths",
      value: `${bathCount} bath${bathCount === 1 ? "" : "s"}`,
      label: bathrooms.length > 0 && privateCount > 0 ? `${privateCount} private` : undefined,
    });
  }

  const availability = earliestAvailability(rooms.map((r) => r.availability));
  if (availability) facts.push({ id: "availability", value: availability });

  if (property.petFriendly) facts.push({ id: "pets", value: "Pets OK" });

  return facts;
}

export function earliestAvailability(availabilities: string[]): string | null {
  if (availabilities.some((text) => roomAvailabilityTone(text) === "available")) return "Available now";
  return earliestRoomOpening(availabilities.filter((text) => roomAvailabilityTone(text) === "future"));
}

const ICONS: Record<ListingKeyFactId, ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>> = {
  rent: DollarSign,
  rooms: BedDouble,
  baths: Bath,
  availability: CalendarDays,
  pets: PawPrint,
};

export function ListingKeyFacts({ facts, className = "" }: { facts: ListingKeyFact[]; className?: string }) {
  if (facts.length === 0) return null;
  const cols =
    facts.length >= 5
      ? "lg:grid-cols-5"
      : facts.length === 4
        ? "lg:grid-cols-4"
        : facts.length === 3
          ? "lg:grid-cols-3"
          : "lg:grid-cols-2";
  return (
    <ul className={`grid grid-cols-2 gap-2 ${cols} ${className}`} data-attr="listing-key-facts">
      {facts.map((fact) => {
        const Icon = ICONS[fact.id];
        return (
          <li
            key={fact.id}
            className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 listing-detail-surface"
          >
            <Icon className="h-[18px] w-[18px] shrink-0 text-primary" strokeWidth={2} aria-hidden />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold tracking-tight text-foreground tabular-nums">{fact.value}</p>
              {fact.label ? <p className="truncate text-[11.5px] font-medium text-muted">{fact.label}</p> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
